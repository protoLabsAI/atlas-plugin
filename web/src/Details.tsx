// Element details side panel (the inspector): title, kind, technology, description, metadata,
// tags, links, drill-down + "appears in". DS components throughout (@protolabsai/ui); code-link
// ROUTING stays ours (click = code pane, ⌘/Ctrl = editor; pane off → editor + hint).
import { Badge, Button, Chip, Tag, TextLink } from '@protolabsai/ui/primitives'
import { PanelHeader } from '@protolabsai/ui/navigation'
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

const where = (l: any) => `${l.path}${l.line ? `:${l.line}${l.endLine ? `–${l.endLine}` : ''}` : ''}`

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
  const title = el.title || fqn
  return (
    <aside className="details" aria-label="Element details" data-fqn={fqn}>
      <PanelHeader
        compact
        kicker={
          <>
            {el.kind}
            {parent ? (
              <>
                {' in '}
                <button type="button" className="linkish" onClick={() => onOpenView(scopedViewOf(data, parentFqn) ?? 'index', undefined)} title={parentFqn!}>
                  {parent.title || parentFqn}
                </button>
              </>
            ) : null}
          </>
        }
        title={title}
        actions={
          <Button variant="ghost" size="sm" icon aria-label="Close details" onClick={onClose}>
            ×
          </Button>
        }
      />
      <div className="d-body">
        {el.technology && (
          <div className="d-tech">
            <Badge>{el.technology}</Badge>
          </div>
        )}
        {summary && summary !== desc && (
          <div className="d-summary" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(summary, { codeRefs: true }) }} />
        )}
        {desc && <div className="d-desc" onClick={onCodeRefClick} onKeyDown={onCodeRefClick} dangerouslySetInnerHTML={{ __html: mdLight(desc, { codeRefs: true }) }} />}
        {(drill || onAsk) && (
          <div className="d-actions">
            {drill && (
              <Button size="sm" onClick={() => onOpenView(drill)}>
                Open drill-down ›
              </Button>
            )}
            {onAsk && (
              <Button size="sm" data-testid="ask" onClick={onAsk} title="Draft a question about this element in the chat box">
                Ask about this
              </Button>
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
                    <div className="d-code-row" data-testid="code-link-row">
                      {/* the DS Chip points at the code location; the sibling Buttons are the explicit actions */}
                      <span data-testid="code-link" className="d-chip">
                        <Chip
                          label={l.title}
                          meta={where(l)}
                          mono
                          icon="⌥"
                          title={paneOn === false ? `Open ${where(l)} in your editor` : `View ${where(l)} in the code pane (⌘/Ctrl-click: open in editor)`}
                          onClick={(e) => onCode(l, title, e)}
                        />
                      </span>
                      <span className="d-code-actions">
                        {paneOn !== false && (
                          <Button size="xs" variant="primary" data-testid="code-view" onClick={() => onCode(l, title, 'pane')}>
                            View
                          </Button>
                        )}
                        <Button size="xs" variant={paneOn === false ? 'primary' : 'default'} data-testid="code-editor" onClick={() => onCode(l, title, 'editor')}>
                          Open in editor
                        </Button>
                      </span>
                    </div>
                  ) : l.kind === 'web' ? (
                    <TextLink href={l.url} external>
                      {l.title} ↗
                    </TextLink>
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
                <Tag key={t}>#{t}</Tag>
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
                  <button type="button" className="linkish" onClick={() => onOpenView(v.id, fqn)}>
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
      </div>
    </aside>
  )
}
