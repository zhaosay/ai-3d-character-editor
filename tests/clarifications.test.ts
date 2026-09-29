import { describe, expect, it } from 'vitest';
import { buildClarificationRequest, clarificationChoices, parseClarificationRequest } from '../src/core/previs/clarifications';
import { decomposeSceneAction, type StageProp } from '../src/core/previs/world';

const props: StageProp[] = [
  { id: 'table-a', kind: 'table', position: [0, 0, 0], rotationY: 0, size: { width: 1, height: 1, length: 1 } },
  { id: 'phone-a', kind: 'phone', position: [0, 1, 0], rotationY: 0, size: { width: 0.1, height: 0.02, length: 0.16 } },
];

describe('previs clarifications', () => {
  it('round-trips original wording and selected answer without delimiter ambiguity', () => {
    const original = '人物说“然后”走到床边\n停下';
    const answer = '在场景添加床并躺到床面';
    expect(parseClarificationRequest(buildClarificationRequest(original, '是否添加床？', answer)))
      .toEqual({ originalPrompt: original, answer });
  });

  it('offers concrete choices for missing props and scene-aware targets', () => {
    expect(clarificationChoices('场景中没有床，要用哪个支撑面？', [])).toContain('按地面仰卧预演');
    expect(clarificationChoices('手机不存在，如何处理？', [])).toContain('不添加手机，只保留伸手动作');
    expect(clarificationChoices('选择哪个目标物体？', props)).toEqual(['以table（table-a）为目标', '以phone（phone-a）为目标']);
  });

  it('offers only the candidate IDs when a same-kind target is ambiguous', () => {
    expect(clarificationChoices('手机目标不明确，请选择具体道具：phone-a、phone-b', props)).toEqual([
      '使用道具 phone-a', '使用道具 phone-b',
    ]);
  });

  it('uses the selected scene prop ID on the clarification replanning pass', () => {
    const phoneB = { ...props[1], id: 'phone-b', position: [1, 1, 0] as [number, number, number] };
    const request = parseClarificationRequest(buildClarificationRequest('拿起手机', '请选择手机目标', '使用道具 phone-b'))!;
    const plan = decomposeSceneAction(`${request.originalPrompt}，${request.answer}`, 4, [...props, phoneB]);
    expect(plan?.targetPropId).toBe('phone-b');
  });

  it('leaves unknown questions open for a typed answer', () => {
    expect(clarificationChoices('这个动作希望持续多久？', [])).toEqual([]);
  });
});
