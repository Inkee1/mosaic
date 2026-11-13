import { useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  Check,
  ChevronDown,
  Globe2,
  Leaf,
  Link2,
  MessageCircle,
  Paperclip,
  Plus,
  Search,
  Send,
  Sparkles,
  TrendingUp,
} from 'lucide-react';
import type { PageKind } from '../model';
import { t } from '../i18n';

function Research({ progress }: { progress: number }) {
  return (
    <div className="demo-research">
      <div className="demo-site-top">
        <span className="fieldnotes-brand">
          <span className="asterisk">✳</span> fieldnotes
        </span>
        <span className="sample-tag">{t('리서치 예시')}</span>
      </div>
      <div className="research-inner">
        <div className="eyebrow">CULTURE & CONSUMER / 2026</div>
        <h2>{t('다음 트렌드의 시작은,')}<br />{t('사람들의 작은 변화에서.')}</h2>
        <div className="research-query">
          <Search size={15} />
          <span>{t('2026 라이프스타일 & 브랜드 트렌드')}</span>
          <ArrowRight size={15} />
        </div>
        <div className="research-tabs">
          <span className="selected">{t('인사이트')}</span>
          <span>{t('소스')}{' '}<small>08</small>
          </span>
          <span>{t('관련 질문')}</span>
        </div>
        <div className="source-row">
          <div>
            <i className="source-mark mint">K</i>
            <b>Kinfolk</b>
            <small>{t('일상을 바라보는 새로운 시선')}</small>
          </div>
          <div>
            <i className="source-mark peach">M</i>
            <b>Monocle</b>
            <small>{t('더 나은 삶을 위한 선택')}</small>
          </div>
        </div>
        <h3>{t('크게 말하기보다, 깊이 연결하기')}</h3>
        <p>{t('소비자들은 더 많은 선택지보다 나에게 맞는 하나를 찾고 있습니다. 브랜드의 이야기가 일상의 경험과 만나는 순간, 오래가는 관계가 만들어집니다.')}</p>
        <div className="insight-callout">
          <Leaf size={17} />
          <span>
            <b>{t('이번 리서치의 핵심')}</b>
            <br />{t('느린 일상 · 취향의 커뮤니티 · 오래 쓰는 물건')}</span>
        </div>
        <h3>{t('01. 작은 취향이 만드는 커뮤니티')}</h3>
        <p>{t('같은 관심사를 공유하는 사람들의 작은 모임이 발견과 구매의 출발점이 됩니다. 규모보다 대화의 밀도가 중요합니다.')}</p>
        <h3>{t('02. 덜어낼수록 선명해지는 브랜드')}</h3>
        <p>{t('제품의 수보다 하나의 제품에 담긴 이유를 설명하는 브랜드가 주목받습니다. 투명한 과정과 구체적인 태도가 차이를 만듭니다.')}</p>
        {progress >= 2 && (
          <div className="agent-result">
            <Sparkles size={15} />
            <div>
              <b>{t('에이전트 데모 · 리서치 정리 완료')}</b>
              <p>{t('세 가지 키워드를 캠페인 노트에 연결했습니다. 실제 웹 검색이 아닌 미리 준비된 예시입니다.')}</p>
            </div>
          </div>
        )}
        <div className="demo-footnote">{t('디자인 검토를 위한 샘플 콘텐츠 · 실제 검색 결과가 아닙니다.')}</div>
      </div>
    </div>
  );
}

function Document({ progress }: { progress: number }) {
  const [note, setNote] = useState<string | null>(null);
  const [checks, setChecks] = useState([true, false, false]);
  return (
    <div className="demo-document">
      <div className="demo-site-top">
        <span className="doc-brand">
          N
          <span>
            My workspace <i>/</i>{' '}{t('캠페인 노트')}</span>
        </span>
        <span className="sample-tag">{t('문서 예시')}</span>
      </div>
      <div className="document-cover">
        <span>
          make room
          <br />
          <b>for the everyday.</b>
        </span>
        <div className="cover-orbit one" />
        <div className="cover-orbit two" />
        <div className="cover-orbit three" />
        <small>STUDIO NOTES — 001</small>
      </div>
      <div className="document-inner">
        <span className="document-symbol">
          <Leaf size={26} />
        </span>
        <h2>{t('작은 일상, 새로운 발견')}</h2>
        <p className="document-subtitle">{t('2026 브랜드 캠페인 · 첫 번째 아이디어')}</p>
        <div className="document-properties">
          <span>{t('진행 상태')}</span>
          <b className="status-pill">{t('기획 중')}</b>
          <span>{t('담당 프로필')}</span>
          <b>{t('브랜드 팀')}</b>
        </div>
        <hr />
        <h3>{t('우리가 전하고 싶은 이야기')}</h3>
        <textarea
          aria-label={t('캠페인 메모')}
          className="document-note"
          value={note ?? t('바쁜 하루에 작은 여백을 만드는 브랜드.\n제품보다 그 제품과 함께하는 시간을 이야기해 보자.')}
          onChange={(e) => setNote(e.target.value)}
        />
        <h3>{t('이번 주에 함께할 일')}</h3>
        {[
          '브랜드 키워드와 레퍼런스 정리',
          '캠페인 메시지 3가지 방향 잡기',
          '랜딩 페이지 초안 작성',
        ].map((task, index) => (
          <label className="doc-task" key={task}>
            <input
              type="checkbox"
              checked={checks[index]}
              onChange={() => setChecks((prev) => prev.map((v, i) => (i === index ? !v : v)))}
            />
            <span>{t(task)}</span>
          </label>
        ))}
        {progress >= 3 && (
          <div className="agent-result">
            <Sparkles size={15} />
            <div>
              <b>{t('에이전트 데모가 추가한 초안')}</b>
              <p>{t('“당신의 하루에, 작은 여백 하나.”')}<br />{t('취향을 나누는 사람들과 오래 함께할 캠페인을 제안합니다.')}</p>
            </div>
          </div>
        )}
        <blockquote>{t('좋은 이야기는, 우리가 매일 하는 일에서 시작된다.')}</blockquote>
        <h3>{t('레퍼런스 보드')}</h3>
        <div className="reference-swatches">
          <span>
            Quiet
            <br />
            mornings
          </span>
          <span>
            Small
            <br />
            rituals
          </span>
          <span>
            Natural
            <br />
            connections
          </span>
        </div>
        <div className="demo-footnote">{t('직접 메모를 수정해 보세요. 집중 모드를 바꿔도 입력은 유지됩니다.')}</div>
      </div>
    </div>
  );
}

function Analytics() {
  const [period, setPeriod] = useState<'week' | 'month'>('week');
  const bars =
    period === 'week'
      ? [26, 42, 34, 63, 49, 77, 91, 68, 83, 98, 84, 115, 101, 128]
      : [45, 30, 65, 52, 77, 64, 98, 86, 104, 89, 128, 114, 136, 145];
  return (
    <div className="demo-analytics">
      <div className="demo-site-top">
        <span className="analytics-brand">
          <span className="tiny-logo">
            <i />
            <i />
            <i />
          </span>{' '}
          pulse<span className="brand-divider">/</span>
          <small>overview</small>
        </span>
        <span className="sample-tag">{t('샘플 데이터')}</span>
      </div>
      <div className="analytics-inner">
        <div className="analytics-heading">
          <div>
            <div className="eyebrow">YOUR BRAND, AT A GLANCE</div>
            <h2>{t('좋은 흐름이 이어지고 있어요')}{' '}<span>↗</span>
            </h2>
          </div>
          <button
            className="period-button"
            onClick={() => setPeriod(period === 'week' ? 'month' : 'week')}
          >
            {period === 'week' ? t('이번 주') : t('이번 달')}
            <ChevronDown size={12} />
          </button>
        </div>
        <div className="metric-row">
          <div>
            <span>{t('전체 방문자')}</span>
            <strong>{period === 'week' ? '24,892' : '98,410'}</strong>
            <small>
              <TrendingUp size={11} /> 18.6% <i>{t('이전 기간 대비')}</i>
            </small>
          </div>
          <div>
            <span>{t('전환율')}</span>
            <strong>
              4.82<em>%</em>
            </strong>
            <small>
              <TrendingUp size={11} /> 2.4% <i>{t('이전 기간 대비')}</i>
            </small>
          </div>
          <div>
            <span>{t('캠페인 도달')}</span>
            <strong>
              {period === 'week' ? '128.4' : '512.8'}
              <em>k</em>
            </strong>
            <small>
              <TrendingUp size={11} /> 24.8%
            </small>
          </div>
        </div>
        <div className="chart-heading">
          <b>{t('방문자 추이')}</b>
          <span>
            <i />{t('이번 기간')}</span>
        </div>
        <div className="chart">
          <div className="chart-grid">
            <span>30k</span>
            <span>20k</span>
            <span>10k</span>
            <span>0</span>
          </div>
          <div className="chart-bars">
            {bars.map((height, index) => (
              <div
                key={index}
                style={{ height: height + 'px' }}
                className={index > 10 ? 'highlight' : ''}
              >
                <span>{(height * 182).toLocaleString()}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="chart-axis">
          <span>11.03</span>
          <span>11.05</span>
          <span>11.07</span>
          <span>11.09</span>
        </div>
        <div className="chart-heading table-heading">
          <b>{t('유입 채널')}</b>
          <span>{t('방문자')}{' '}<ArrowUpRight size={12} />
          </span>
        </div>
        <div className="channel-table">
          {[
            ['Organic search', '9,482', '38.1%', '#73a18d'],
            ['Social media', '7,146', '28.7%', '#b6c3a0'],
            ['Direct', '5,032', '20.2%', '#d9b894'],
            ['Referral', '3,232', '13.0%', '#b2a5c7'],
          ].map((row) => (
            <div key={row[0]}>
              <span>
                <i style={{ background: row[3] }} />
                {row[0]}
              </span>
              <b>{row[1]}</b>
              <small>{row[2]}</small>
            </div>
          ))}
        </div>
        <div className="demo-footnote">{t('UI 검토용 가상 지표입니다. 실제 분석 서비스와 연결되지 않았습니다.')}</div>
      </div>
    </div>
  );
}

function Chat({ progress }: { progress: number }) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<string[]>([]);
  return (
    <div className="demo-chat">
      <div className="demo-site-top">
        <span className="chat-brand">
          <Sparkles size={17} /> atelier <ChevronDown size={12} />
        </span>
        <span className="sample-tag">{t('AI 채팅 예시')}</span>
      </div>
      <div className="chat-inner">
        <div className="chat-day">{t('새로운 아이디어가 시작되는 곳')}</div>
        <div className="chat-user">{t('일상의 작은 여유를 전하는 브랜드 캠페인,')}<br />{t('어떤 이야기로 시작하면 좋을까?')}</div>
        <div className="chat-answer">
          <span className="chat-avatar">
            <Sparkles size={15} />
          </span>
          <div>
            <b>{t('평범한 하루를, 조금 다르게.')}</b>
            <p>{t('거창한 변화보다 일상에서 발견할 수 있는 작은 순간에 집중해 보면 어떨까요?')}</p>
            <div className="idea-card">
              <span>01 / CAMPAIGN IDEA</span>
              <h3>{t('당신의 하루에,')}<br />
                <em>{t('작은 여백 하나.')}</em>
              </h3>
              <p>{t('아침의 차 한 잔, 창가에 머무는 햇빛.')}<br />{t('우리가 잊고 있던 일상의 감각을 다시 만나요.')}</p>
              <span className="idea-line" />
            </div>
            <div className="chat-actions">
              <MessageCircle size={12} />
              <span>{t('함께 발전시키기')}</span>
              <span>·</span>
              <Link2 size={12} />
              <span>{t('노트에 연결')}</span>
            </div>
          </div>
        </div>
        {progress >= 4 && (
          <div className="agent-result">
            <Check size={15} />
            <div>
              <b>{t('에이전트 데모 · 아이디어 연결 완료')}</b>
              <p>{t('리서치 키워드와 캠페인 메시지를 하나의 예시로 정리했습니다.')}</p>
            </div>
          </div>
        )}
        {messages.map((message, index) => (
          <div key={index}>
            <div className="chat-user">{message}</div>
            <div className="chat-answer">
              <span className="chat-avatar">
                <Sparkles size={15} />
              </span>
              <p>{t('입력한 메시지를 확인했어요. 이 화면은 UI 데모이며, 실제 AI 답변은 엔진 연결 후 제공됩니다.')}</p>
            </div>
          </div>
        ))}
        <form
          className="chat-compose"
          onSubmit={(event) => {
            event.preventDefault();
            if (draft.trim()) {
              setMessages((prev) => [...prev, draft.trim()]);
              setDraft('');
            }
          }}
        >
          <input
            aria-label={t('샘플 채팅 메시지')}
            placeholder={t('아이디어를 이어가 보세요…')}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
          <div>
            <span>
              <Plus size={15} />
              <Paperclip size={14} />
              <small>{t('로컬 데모')}</small>
            </span>
            <button aria-label={t('샘플 메시지 보내기')} disabled={!draft.trim()}>
              <ArrowRight size={15} />
            </button>
          </div>
        </form>
        <div className="demo-footnote">{t('샘플 대화 · 입력 내용은 외부 AI에 전송되지 않습니다.')}</div>
      </div>
    </div>
  );
}

export default function DemoPage({
  kind,
  url,
  progress,
}: {
  kind: PageKind;
  url: string;
  progress: number;
}) {
  if (kind === 'research') return <Research progress={progress} />;
  if (kind === 'document') return <Document progress={progress} />;
  if (kind === 'analytics') return <Analytics />;
  if (kind === 'chat') return <Chat progress={progress} />;
  return (
    <div className="external-placeholder">
      <div className="external-icon">
        <Globe2 size={30} />
      </div>
      <span className="eyebrow">READY FOR THE NEXT STEP</span>
      <h2>{t('새로운 화면이 준비됐어요')}</h2>
      <p>{t('주소와 프로필을 이 작업 공간에 저장했어요.')}<br />{t('실제 웹 탐색은 Chromium 엔진을 연결하면 사용할 수 있습니다.')}</p>
      <code>{url}</code>
      <span className="sample-tag">{t('현재는 UI 미리보기입니다')}</span>
    </div>
  );
}
