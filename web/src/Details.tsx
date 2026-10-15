// Element details side panel: title, kind, technology, description, metadata, tags, links,
// drill-down + "appears in". Code links ask the console to open its code pane.
import { descriptionText, mdLight, normaliseLinks, scopedViewOf, viewList } from './logic.mjs'

type Mods = { metaKey?: boolean; ctrlKey?: boolean }
type Props = {
  data: any
  fqn: string
  paneOn: boolean | null
  onClose: () => void
  onOpenView: (view: string, focus?: string) => void
  /** `how`: a click's modifiers (click = pane, ⌘/Ctrl = editor) or an explicit target */
  onCode: (link: any, note: string, how: Mods | 'pane' | 'editor') => void
  onCodeRefClick: (e: React.MouseEvent | React.KeyboardEvent) => void
  /** "Ask about this" (protoagent:chat:compose) — absent when the host can't */
  onAsk?: () => void
}

export function Details({ data, fqn, paneOn, onClose, onOpenView, onCode, onCodeRefClick, onAsk }: Props) {
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
        <button className="pl-btn pl-btn--ghost pl-btn--icon pl-btn--sm d-close" aria-label="Close details" onClick={onClose}>
          ×
        </button>
      </header>
      {el.technology && <span className="pl-badge d-tech">{el.technology}</span>}
      {summary && summary !== desc && <div className="d-summary" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(summary, { codeRefs: true }) }} />}
      {desc && <div className="d-desc" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(desc, { codeRefs: true }) }} />}
      {(drill || onAsk) && (
        <div className="d-actions">
          {drill && (
            <button className="pl-btn pl-btn--sm d-drill" onClick={() => onOpenView(drill)}>
              Open drill-down ›
            </button>
          )}
          {onAsk && (
            <button className="pl-btn pl-btn--sm" data-testid="ask" onClick={onAsk} title="Draft a question about this element in the chat box">
              Ask about this
            </button>
          )}
        </div>
      )}
      {links.length > 0 && (
        <section>
          <h3>Links</h3>
          {paneOn === false && links.some((l: any) => l.kind === 'code') && (
            <p className="d-hint" data-testid="pane-hint">
              Turn on the code pane in <strong>Tools ▸ Filesystem</strong> to view code here.
            </p>
          )}
          <ul className="d-links">
            {links.map((l: any, i: number) => (
              <li key={i}>
                {l.kind === 'code' ? (
                  <div className="d-code-row">
                    <button
                      className="d-code"
                      data-testid="code-link"
                      onClick={(e) => onCode(l, el.title || fqn, e)}
                      title={paneOn === false ? `Open ${l.path} in your editor` : `View ${l.path} in the code pane (⌘/Ctrl-click: open in editor)`}
                    >
                      <span className="d-ico" aria-hidden>
                        ⌥
                      </span>
                      <span className="d-ltitle">{l.title}</span>
                      <code>
                        {l.path}
                        {l.line ? `:${l.line}${l.endLine ? `–${l.endLine}` : ''}` : ''}
                      </code>
                    </button>
                    <span className="d-code-actions">
                      {paneOn !== false && (
                        <button className="pl-btn pl-btn--xs pl-btn--primary" data-testid="code-view" onClick={() => onCode(l, el.title || fqn, 'pane')}>
                          View
                        </button>
                      )}
                      <button className={`pl-btn pl-btn--xs${paneOn === false ? ' pl-btn--primary' : ''}`} data-testid="code-editor" onClick={() => onCode(l, el.title || fqn, 'editor')}>
                        Open in editor
                      </button>
                    </span>
                  </div>
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
              <span key={t} className="pl-tag">
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
