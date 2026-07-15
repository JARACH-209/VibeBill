import { describe, expect, it } from 'vitest';
import {
  convertLiteLLMTable,
  nanoPerMTokToPriceString,
  perTokenCostToPerMTokString,
  selectModelId,
} from './convert.js';
import { parsePriceToNanoPerMTok } from './money.js';

describe('nanoPerMTokToPriceString', () => {
  it('emits canonical decimal strings that round-trip through the exact parser', () => {
    const cases: Array<[bigint, string]> = [
      [15_000_000_000n, '15'],
      [250_000_000n, '0.25'],
      [0n, '0'],
      [1n, '0.000000001'],
      [6_250_000_000n, '6.25'],
      [3_625_000n, '0.003625'],
      [1_500_000_000n, '1.5'],
    ];
    for (const [nano, s] of cases) {
      expect(nanoPerMTokToPriceString(nano)).toBe(s);
      expect(parsePriceToNanoPerMTok(s)).toBe(nano);
    }
  });

  it('rejects negative values', () => {
    expect(() => nanoPerMTokToPriceString(-1n)).toThrow();
  });
});

describe('perTokenCostToPerMTokString', () => {
  it('converts per-token floats to exact $/MTok decimal strings', () => {
    expect(perTokenCostToPerMTokString(1.5e-5)).toBe('15');
    expect(perTokenCostToPerMTokString(2.5e-7)).toBe('0.25');
    expect(perTokenCostToPerMTokString(5e-7)).toBe('0.5');
    expect(perTokenCostToPerMTokString(6.25e-6)).toBe('6.25');
    expect(perTokenCostToPerMTokString(2.8e-9)).toBe('0.0028');
    expect(perTokenCostToPerMTokString(3.625e-9)).toBe('0.003625');
    expect(perTokenCostToPerMTokString(0)).toBe('0');
    expect(perTokenCostToPerMTokString(6e-4)).toBe('600');
  });

  it('snaps float artifacts (2.19e-6 * 1e6 = 2.1900000000000004)', () => {
    expect(perTokenCostToPerMTokString(2.19e-6)).toBe('2.19');
    expect(perTokenCostToPerMTokString(1.1e-6)).toBe('1.1');
  });

  it('rejects negative, NaN, and infinite costs', () => {
    for (const bad of [-1e-6, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => perTokenCostToPerMTokString(bad)).toThrow();
    }
  });

  it('every produced string parses with the exact money parser', () => {
    for (const v of [1.5e-5, 2.5e-7, 7.5e-6, 1.66e-7, 2.19e-6, 0.00015]) {
      expect(() => parsePriceToNanoPerMTok(perTokenCostToPerMTokString(v))).not.toThrow();
    }
  });
});

describe('selectModelId', () => {
  it('keeps anthropic claude-* keys as-is', () => {
    expect(selectModelId('claude-opus-4-8', 'anthropic')).toBe('claude-opus-4-8');
    expect(selectModelId('claude-3-haiku-20240307', 'anthropic')).toBe('claude-3-haiku-20240307');
  });

  it('accepts openai gpt-/o<digit>/codex-/chatgpt- keys only', () => {
    expect(selectModelId('gpt-5.1', 'openai')).toBe('gpt-5.1');
    expect(selectModelId('o3-mini', 'openai')).toBe('o3-mini');
    expect(selectModelId('codex-mini-latest', 'openai')).toBe('codex-mini-latest');
    expect(selectModelId('chatgpt-4o-latest', 'openai')).toBe('chatgpt-4o-latest');
    expect(selectModelId('text-embedding-3-small', 'openai')).toBeNull();
    expect(selectModelId('whisper-1', 'openai')).toBeNull();
  });

  it('strips gemini/ and deepseek/ provider prefixes', () => {
    expect(selectModelId('gemini/gemini-2.5-pro', 'gemini')).toBe('gemini-2.5-pro');
    expect(selectModelId('gemini/other-model', 'gemini')).toBeNull();
    expect(selectModelId('deepseek/deepseek-chat', 'deepseek')).toBe('deepseek-chat');
  });

  it('accepts dashscope/alibaba qwen coder models, stripped', () => {
    expect(selectModelId('dashscope/qwen3-coder-plus', 'dashscope')).toBe('qwen3-coder-plus');
    expect(selectModelId('alibaba/qwen-coder', 'alibaba')).toBe('qwen-coder');
    expect(selectModelId('dashscope/qwen-max', 'dashscope')).toBeNull();
  });

  it('rejects other providers and missing provider', () => {
    expect(selectModelId('mistral/mistral-large', 'mistral')).toBeNull();
    expect(selectModelId('claude-opus-4-8', undefined)).toBeNull();
    expect(selectModelId('claude-opus-4-8', 'bedrock')).toBeNull();
  });
});

describe('convertLiteLLMTable', () => {
  const base = { mode: 'chat', litellm_provider: 'anthropic' };

  it('omits models missing input or output cost', () => {
    const models = convertLiteLLMTable({
      'claude-a': { ...base, input_cost_per_token: 1e-6 }, // no output cost
      'claude-b': { ...base, output_cost_per_token: 1e-6 }, // no input cost
      'claude-c': { ...base, input_cost_per_token: 1e-6, output_cost_per_token: 5e-6 },
    });
    expect(Object.keys(models)).toEqual(['claude-c']);
  });

  it('omits non-chat/responses modes and ignores sample_spec', () => {
    const models = convertLiteLLMTable({
      sample_spec: { mode: 'chat', litellm_provider: 'anthropic' },
      'claude-img': { ...base, mode: 'image_generation', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
      'claude-resp': { ...base, mode: 'responses', input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    });
    expect(Object.keys(models)).toEqual(['claude-resp']);
  });

  it('skips malformed entries without throwing', () => {
    const models = convertLiteLLMTable({
      'claude-bad': { ...base, input_cost_per_token: 'cheap', output_cost_per_token: 1e-6 },
      'claude-null': null,
      'claude-ok': { ...base, input_cost_per_token: 1e-6, output_cost_per_token: 1e-6 },
    });
    expect(Object.keys(models)).toEqual(['claude-ok']);
  });

  it('throws on a payload that is not an object', () => {
    expect(() => convertLiteLLMTable('nope')).toThrow();
    expect(() => convertLiteLLMTable([1, 2])).toThrow();
    expect(() => convertLiteLLMTable(null)).toThrow();
  });
});
