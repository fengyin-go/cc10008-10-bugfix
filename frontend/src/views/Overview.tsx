import { useCallback, useEffect, useState } from 'react'

import { loadOverview } from '@/api/local-service'
import type { OverviewResult } from '@/data/types'

export default function Overview() {
  const [cards, setCards] = useState<OverviewResult['cards']>([])
  const [moduleRows, setModuleRows] = useState<OverviewResult['modules']>([])

  const refresh = useCallback(() => {
    const payload = loadOverview()
    setCards(payload.cards)
    setModuleRows(payload.modules)
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h2>运营概览</h2>
          <p className="page-desc">汇总各业务模块的关键指标，先看总量再看异常。</p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={refresh}>重新统计</button>
        </div>
      </header>
      <div className="stat-row">
        {cards.map((card) => (
          <article key={card.label} className="stat-card">
            <span className="stat-label">{card.label}</span>
            <strong className="stat-value">{card.value}</strong>
          </article>
        ))}
      </div>
      <table className="data-table">
        <thead>
          <tr><th>业务模块</th><th>今日新增</th><th>待处理</th><th>异常量</th></tr>
        </thead>
        <tbody>
          {moduleRows.map((row) => (
            <tr key={row.name}>
              <td>{row.name}</td>
              <td>{row.created}</td>
              <td>{row.pending}</td>
              <td>{row.abnormal}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <footer className="page-foot">
        <span>数据保存在本机浏览器里，换浏览器或清缓存会回到示例数据</span>
      </footer>
    </section>
  )
}
