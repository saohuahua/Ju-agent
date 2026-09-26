import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const corpusPath = resolve(root, 'packages/persistence/src/fixtures.ts')
const versionPath = resolve(root, 'packages/domain/src/policy.ts')
const datasetPath = resolve(root, 'eval/rag/dataset-v1.1.json')
const errors: string[] = []

function sourceFile(path: string): ts.SourceFile {
  const text = readFileSync(path, 'utf8')
  return ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
}

function variable(source: ts.SourceFile, name: string): ts.Expression {
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (
        ts.isIdentifier(declaration.name) &&
        declaration.name.text === name &&
        declaration.initializer
      ) {
        return declaration.initializer
      }
    }
  }
  throw new Error(`未找到源码变量 ${name}`)
}

function field(node: ts.ObjectLiteralExpression, name: string): ts.Expression {
  const item = node.properties.find(
    (property) =>
      ts.isPropertyAssignment(property) &&
      (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) &&
      property.name.text === name,
  )
  if (!item || !ts.isPropertyAssignment(item)) throw new Error(`语料缺少字段 ${name}`)
  return item.initializer
}

function objectNode(node: ts.Expression): ts.ObjectLiteralExpression {
  if (!ts.isObjectLiteralExpression(node)) throw new Error('语料结构不是对象字面量')
  return node
}

function stringNode(node: ts.Expression): string {
  if (!ts.isStringLiteral(node) && !ts.isNoSubstitutionTemplateLiteral(node)) {
    throw new Error('语料字段不是字符串字面量')
  }
  return node.text
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} 必须是非空字符串`)
  return value
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`)
  return value
}

function stringArray(value: unknown, label: string): string[] {
  return array(value, label).map((item, index) => string(item, `${label}[${index}]`))
}

// 只读取政策字面量 不运行应用或检索器
const fixture = objectNode(variable(sourceFile(corpusPath), 'BASELINE_FIXTURE'))
const articlesNode = field(fixture, 'policyArticles')
if (!ts.isArrayLiteralExpression(articlesNode)) throw new Error('policyArticles 不是数组字面量')
const articles = articlesNode.elements.map((element) => {
  if (!ts.isObjectLiteralExpression(element)) throw new Error('政策条目不是对象字面量')
  return {
    articleId: stringNode(field(element, 'article_id')),
    title: stringNode(field(element, 'title')),
    content: stringNode(field(element, 'content')),
    source: stringNode(field(element, 'source')),
  }
})
const policyVersion = stringNode(variable(sourceFile(versionPath), 'POLICY_VERSION'))
const corpusSha256 = createHash('sha256')
  .update(JSON.stringify({ policyVersion, articles }))
  .digest('hex')
const byId = new Map(articles.map((article) => [article.articleId, article]))
if (byId.size !== articles.length) errors.push('源语料存在重复 articleId')

const dataset = record(JSON.parse(readFileSync(datasetPath, 'utf8')) as unknown, '数据集')
if (dataset.datasetVersion !== 'rag-relevance-v1.1') errors.push('数据集版本不匹配')
if (dataset.provenance !== 'constructed_from_demo_policy_fixture_not_user_samples') {
  errors.push('数据来源标识不匹配')
}
if (dataset.policyVersion !== policyVersion) errors.push('政策版本与源码不一致')
if (
  dataset.corpusSource !== 'packages/persistence/src/fixtures.ts#BASELINE_FIXTURE.policyArticles'
) {
  errors.push('语料来源路径不匹配')
}
if (dataset.corpusSha256 !== corpusSha256) {
  errors.push(`语料摘要不匹配 当前源码摘要为 ${corpusSha256}`)
}

const splits = new Set(['tuning', 'holdout'])
const types = new Set([
  'direct_clause',
  'paraphrase',
  'multi_clause',
  'confusable_clause',
  'no_answer',
  'ambiguous_request',
])
const answerabilities = new Set(['supported', 'unsupported', 'needs_clarification'])
const ids = new Set<string>()
const questions = new Set<string>()
const families = new Map<string, string>()
const coverage = new Map<string, Set<string>>()
const cases = array(dataset.cases, 'cases')

for (const [index, raw] of cases.entries()) {
  const item = record(raw, `cases[${index}]`)
  const label = string(item.id, `cases[${index}].id`)
  const split = string(item.split, `${label}.split`)
  const family = string(item.family, `${label}.family`)
  const type = string(item.type, `${label}.type`)
  const answerability = string(item.answerability, `${label}.answerability`)
  const question = string(item.question, `${label}.question`)
  const rationale = string(item.rationale, `${label}.rationale`)
  const relevant = stringArray(item.relevantArticleIds, `${label}.relevantArticleIds`)
  const confusable = stringArray(item.confusableArticleIds, `${label}.confusableArticleIds`)
  const evidence = array(item.evidence, `${label}.evidence`).map((rawEvidence, evidenceIndex) => {
    const entry = record(rawEvidence, `${label}.evidence[${evidenceIndex}]`)
    return {
      articleId: string(entry.articleId, `${label}.evidence[${evidenceIndex}].articleId`),
      quote: string(entry.quote, `${label}.evidence[${evidenceIndex}].quote`),
    }
  })

  if (item.reviewNote !== undefined) string(item.reviewNote, `${label}.reviewNote`)
  if (!splits.has(split)) errors.push(`${label} 划分非法`)
  if (!types.has(type)) errors.push(`${label} 题型非法`)
  if (!answerabilities.has(answerability)) errors.push(`${label} 可回答性非法`)
  if (ids.has(label)) errors.push(`${label} 题目 ID 重复`)
  if (questions.has(question)) errors.push(`${label} 问题文本重复`)
  if (families.has(family) && families.get(family) !== split) {
    errors.push(`${label} 场景家族跨集合泄漏 ${family}`)
  }
  if (rationale.length < 8) errors.push(`${label} 判定理由过短`)
  ids.add(label)
  questions.add(question)
  families.set(family, split)
  if (!coverage.has(split)) coverage.set(split, new Set())
  coverage.get(split)?.add(type)

  for (const [fieldName, values] of [
    ['relevantArticleIds', relevant],
    ['confusableArticleIds', confusable],
  ] as const) {
    if (new Set(values).size !== values.length) errors.push(`${label}.${fieldName} 有重复 ID`)
    for (const articleId of values) {
      if (!byId.has(articleId)) errors.push(`${label}.${fieldName} 引用不存在的政策 ${articleId}`)
    }
  }
  for (const articleId of confusable) {
    if (relevant.includes(articleId))
      errors.push(`${label} 同一政策不能同时相关且易混淆 ${articleId}`)
  }
  const evidenceIds = evidence.map((entry) => entry.articleId)
  if (new Set(evidenceIds).size !== evidenceIds.length) errors.push(`${label} 证据政策 ID 重复`)
  if (
    evidenceIds.length !== relevant.length ||
    evidenceIds.some((articleId) => !relevant.includes(articleId))
  ) {
    errors.push(`${label} 证据 ID 必须与相关政策 ID 一一对应`)
  }
  for (const entry of evidence) {
    const article = byId.get(entry.articleId)
    if (!article) {
      errors.push(`${label} 证据引用不存在的政策 ${entry.articleId}`)
    } else if (!article.content.includes(entry.quote)) {
      errors.push(`${label} 证据并非政策原文 ${entry.articleId}`)
    }
  }
  if (answerability === 'supported' && relevant.length === 0)
    errors.push(`${label} 可回答题缺少证据`)
  if (answerability === 'unsupported' && relevant.length !== 0)
    errors.push(`${label} 无答案题不能标相关政策`)
  if (type === 'no_answer' && answerability !== 'unsupported')
    errors.push(`${label} 无答案题标注不一致`)
  if (type === 'ambiguous_request' && answerability !== 'needs_clarification') {
    errors.push(`${label} 模糊诉求题标注不一致`)
  }
  if (type === 'multi_clause' && relevant.length < 2)
    errors.push(`${label} 多条款题至少需要两篇政策`)
  if (type === 'confusable_clause' && confusable.length === 0)
    errors.push(`${label} 易混淆题缺少干扰政策`)
}

for (const split of splits) {
  for (const type of types) {
    if (!coverage.get(split)?.has(type)) errors.push(`${split} 集缺少题型 ${type}`)
  }
}
const badcase = cases.find(
  (value) => record(value, 'badcase').id === 'T01_keyboard_quality_badcase',
)
if (!badcase) {
  errors.push('缺少机械键盘误召回坏例')
} else {
  const entry = record(badcase, 'badcase')
  if (
    entry.split !== 'tuning' ||
    !stringArray(entry.relevantArticleIds, 'badcase.relevantArticleIds').includes(
      'R3_quality_window',
    ) ||
    !stringArray(entry.confusableArticleIds, 'badcase.confusableArticleIds').includes(
      'D1_fresh_food_no_return',
    )
  ) {
    errors.push('机械键盘坏例缺少质量条款与生鲜干扰标注')
  }
}

if (errors.length > 0) {
  for (const error of errors) console.error(`错误 ${error}`)
  process.exitCode = 1
} else {
  const tuning = cases.filter((value) => record(value, 'case').split === 'tuning').length
  console.log(
    `校验通过 语料 ${articles.length} 篇 题目 ${cases.length} 道 调参 ${tuning} 保留 ${cases.length - tuning}`,
  )
  console.log(`政策版本 ${policyVersion} 语料摘要 ${corpusSha256}`)
}
