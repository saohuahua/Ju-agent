import { expect, it } from 'vitest'
import { createMemoryDatabase, initializeDemo } from '../src/index.js'

it('空库迁移时创建调查关联表', () => {
  const db = createMemoryDatabase()
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
      name: string
    }[]
    expect(tables.map((table) => table.name)).toEqual(
      expect.arrayContaining(['p8_investigations', 'p8_branches']),
    )
  } finally {
    db.close()
  }
})

it('首次事务播种和重复启动不增加记录或覆盖用户修改', () => {
  const db = createMemoryDatabase()
  try {
    expect(initializeDemo(db)).toBe('seeded')
    const count = db.prepare('SELECT COUNT(*) AS n FROM orders').get()
    db.prepare("UPDATE customers SET name = '用户修改' WHERE customer_id = 'C1001'").run()
    expect(initializeDemo(db)).toBe('existing')
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual(count)
    expect(db.prepare("SELECT name FROM customers WHERE customer_id = 'C1001'").get()).toEqual({
      name: '用户修改',
    })
  } finally {
    db.close()
  }
})

it('订单为空但存在费用预算时不播种也不释放占位', () => {
  const db = createMemoryDatabase()
  try {
    db.prepare('INSERT INTO p7_budgets VALUES (?,100000000,1,4)').run('retained')
    expect(initializeDemo(db)).toBe('existing')
    expect(db.prepare('SELECT COUNT(*) AS n FROM orders').get()).toEqual({ n: 0 })
    expect(db.prepare('SELECT blocked FROM p7_budgets').get()).toEqual({ blocked: 1 })
  } finally {
    db.close()
  }
})

it('部分初始化保留原记录而不尝试覆盖', () => {
  const db = createMemoryDatabase()
  try {
    db.prepare("INSERT INTO counters VALUES ('partial',42)").run()
    expect(initializeDemo(db)).toBe('existing')
    expect(db.prepare('SELECT * FROM counters').all()).toEqual([{ key: 'partial', value: 42 }])
  } finally {
    db.close()
  }
})

it('播种中途失败全部回滚 移除故障后可以重试', () => {
  const db = createMemoryDatabase()
  try {
    // 只注入测试数据库 不给正式入口增加重置开关
    db.exec(
      "CREATE TRIGGER fail_seed BEFORE INSERT ON orders BEGIN SELECT RAISE(ABORT,'fault'); END",
    )
    expect(() => initializeDemo(db)).toThrow('fault')
    expect(db.prepare('SELECT COUNT(*) AS n FROM customers').get()).toEqual({ n: 0 })
    db.exec('DROP TRIGGER fail_seed')
    expect(initializeDemo(db)).toBe('seeded')
  } finally {
    db.close()
  }
})
