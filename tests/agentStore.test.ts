import { describe, expect, it } from 'vitest';
import { useAgentStore } from '../src/stores/agentStore';

describe('agent clarification prompt handoff', () => {
  it('queues a clarified prompt for the AI input and consumes it once', () => {
    useAgentStore.getState().queuePrompt('原始描述：躺下睡觉\n用户确认：按地面仰卧预演');
    expect(useAgentStore.getState().queuedPrompt).toContain('按地面仰卧预演');
    useAgentStore.getState().consumeQueuedPrompt();
    expect(useAgentStore.getState().queuedPrompt).toBeNull();
  });

  it('marks confirmed clarification requests for immediate replanning once', () => {
    const before = useAgentStore.getState().runQueuedPromptId;
    useAgentStore.getState().queuePrompt('confirmed request', true);
    expect(useAgentStore.getState().runQueuedPromptId).toBe(before + 1);
    useAgentStore.getState().queuePrompt('draft request');
    expect(useAgentStore.getState().runQueuedPromptId).toBe(before + 1);
  });
});
