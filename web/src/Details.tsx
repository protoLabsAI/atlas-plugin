// Element details side panel: title, kind, technology, description, metadata, tags, links,
// drill-down + "appears in". Code links ask the console to open its code pane.
import { descriptionText, mdLight, normaliseLinks, scopedViewOf, viewList } from './logic.mjs'

type Props = {
  data: any
  fqn: string
  onClose: () => void
  onOpenView: (view: string, focus?: string) => void
  onCode: (link: any, note: string) => void
}

export function Details({ data, fqn, onClose, onOpenView, onCode }: Props) {
  const el = data?.elements?.[fqn]
  if (!el) return null
  const summary = descriptionText(el.summary)
  const desc = descriptionText(el.description)
  const links = normaliseLinks(el.links)
  const meta = el.metadata && typeof el.metadata === 'object' ? Object.entries(el.metadata) : []
  const drill = scopedViewOf(data, fqn)
  const appears = viewList(data).filter((v: any) => v.id !== drill && v.nodes?.some((n: any) => n.id === fqn))
  const parentFqn = fqn.includes('.') ? fqn.slice(0, fqn.lastIndexOf('.')) : null
  const parent = parentFqn ? data.elements[parentFqn] : null
  return (
    <aside className="details" aria-label="Element details" data-fqn={fqn}>
      <header>
        <div className="d-kind">
          {el.kind}
          {parent ? (
            <>
              {' '}
              in{' '}
              <button className="linkish" onClick={() => onOpenView(scopedViewOf(data, parentFqn) ?? 'index', undefined)} title={parentFqn!}>
                {parent.title || parentFqn}
              </button>
            </>
          ) : null}
        </div>
        <h2>{el.title || fqn}</h2>
        <button className="d-close" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      {el.technology && <div className="d-tech">{el.technology}</div>}
      {summary && summary !== desc && <div className="d-summary" dangerouslySetInnerHTML={{ __html: mdLight(summary) }} />}
      {desc && <div className="d-desc" dangerouslySetInnerHTML={{ __html: mdLight(desc) }} />}
      {drill && (
        <button className="pl-btn d-drill" onClick={() => onOpenView(drill)}>
          Open drill-down ›
        </button>
      )}
      {links.length > 0 && (
        <section>
          <h3>Links</h3>
          <ul className="d-links">
            {links.map((l: any, i: number) => (
              <li key={i}>
                {l.kind === 'code' ? (
                  <button className="d-code" data-testid="code-link" onClick={() => onCode(l, el.title || fqn)} title={`Open ${l.path}${l.line ? `:${l.line}` : ''} in the code pane`}>
                    <span className="d-ico" aria-hidden>
                      ⌥
                    </span>
                    <span className="d-ltitle">{l.title}</span>
                    <code>
                      {l.path}
                      {l.line ? `:${l.line}${l.endLine ? `–${l.endLine}` : ''}` : ''}
                    </code>
                  </button>
                ) : l.kind === 'web' ? (
                  <a className="d-web" href={l.url} target="_blank" rel="noopener noreferrer">
                    <span className="d-ico" aria-hidden>
                      ↗
                    </span>
                    <span className="d-ltitle">{l.title}</span>
                  </a>
                ) : (
                  <span className="d-other" title={l.url}>
                    {l.title}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {meta.length > 0 && (
        <section>
          <h3>Metadata</h3>
          <dl className="d-meta">
            {meta.map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {el.tags?.length > 0 && (
        <section>
          <h3>Tags</h3>
          <div className="d-tags">
            {el.tags.map((t: string) => (
              <span key={t} className="tag">
                #{t}
              </span>
            ))}
          </div>
        </section>
      )}
      {appears.length > 0 && (
        <section>
          <h3>Appears in</h3>
          <ul className="d-views">
            {appears.map((v: any) => (
              <li key={v.id}>
                <button className="linkish" onClick={() => onOpenView(v.id, fqn)}>
                  {v.title || v.id}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer>
        <code className="d-fqn">{fqn}</code>
      </footer>
    </aside>
  )
}
