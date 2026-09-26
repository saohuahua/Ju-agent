export interface CalibrationLabel {
  schemaVersion: 1
  rubricVersion: string
  source: 'synthetic' | 'human'
  experimentId: string
  caseId: string
  repeat: number
  rubric: string
  evidenceHash: string
  annotator: string
  humanPassed: boolean
  judgePassed: boolean | null
}

// 人工标签格式预留真实核验 合成夹具只能验证计算
export function calibrationSummary(labels: CalibrationLabel[]) {
  if (!labels.length) return { status: 'not_calibrated', total: 0, scored: 0, agreement: null }
  const keys = labels.map((item) =>
    JSON.stringify([item.experimentId, item.caseId, item.repeat, item.rubric, item.annotator]),
  )
  if (
    new Set(keys).size !== keys.length ||
    new Set(labels.map((item) => item.rubricVersion)).size !== 1 ||
    new Set(labels.map((item) => item.source)).size !== 1 ||
    labels.some(
      (item) =>
        item.schemaVersion !== 1 ||
        !item.evidenceHash ||
        !item.annotator ||
        !item.rubric.trim() ||
        typeof item.humanPassed !== 'boolean' ||
        (item.judgePassed !== null && typeof item.judgePassed !== 'boolean'),
    )
  )
    throw new Error('标签缺失重复或版本来源混合')
  const scored = labels.filter((item) => item.judgePassed !== null)
  return {
    status:
      labels[0]!.source === 'synthetic'
        ? 'synthetic_algorithm_check_only'
        : 'human_label_observation_not_reliability_claim',
    total: labels.length,
    scored: scored.length,
    agreement: scored.length
      ? scored.filter((item) => item.humanPassed === item.judgePassed).length / scored.length
      : null,
    falsePasses: scored.filter((item) => !item.humanPassed && item.judgePassed).length,
    falseRejects: scored.filter((item) => item.humanPassed && !item.judgePassed).length,
  }
}
