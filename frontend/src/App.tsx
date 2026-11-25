import { useEffect, useState } from 'react';
import {
  CalendarClock,
  CheckCircle2,
  Clock3,
  ExternalLink,
  Hash,
  LogOut,
  Mail,
  Plus,
  Search,
  Send,
  Upload,
  X
} from 'lucide-react';

const API = (
  import.meta.env.VITE_API_URL ||
  (import.meta.env.PROD
    ? 'https://reachinbox-email-scheduler-2-eiwq.onrender.com'
    : 'http://localhost:5000')
).replace(/\/+$/, '');

type GoogleUser = {
  id: string;
  email: string;
  name?: string | null;
  picture?: string | null;
  slackConnected?: boolean;
  slackChannel?: string | null;
};

type Email = {
  id: string;
  recipient: string;
  subject: string;
  scheduledAt: string;
  sentAt?: string | null;
  status: string;
  previewUrl?: string | null;
};

export default function App() {
  const [user, setUser] = useState<GoogleUser | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [loginError, setLoginError] = useState('');

  const [tab, setTab] = useState<'scheduled' | 'sent' | 'failed'>('scheduled');
  const [allEmails, setAllEmails] = useState<Email[]>([]);
  const [loading, setLoading] = useState(false);

  const [compose, setCompose] = useState(false);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [senderEmail, setSenderEmail] = useState('');

  const [startAt, setStartAt] = useState(() => {
    const d = new Date();
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
    return d.toISOString().slice(0, 16);
  });

  const [delay, setDelay] = useState(2);
  const [limit, setLimit] = useState(50);
  const [fileRecipients, setFileRecipients] = useState<string[]>([]);
  const [manualRecipients, setManualRecipients] = useState('');
  const [fileName, setFileName] = useState('');
  const [notice, setNotice] = useState('');
  const [search, setSearch] = useState('');

  function authHeaders(extra?: Record<string, string>): Record<string, string> {
    const token = localStorage.getItem('reachinbox_token');
    return {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(extra || {})
    };
  }

  async function checkSession() {
    try {
      const response = await fetch(`${API}/api/auth/me`, {
        credentials: 'include',
        headers: authHeaders()
      });
      if (response.status === 401) {
        localStorage.removeItem('reachinbox_token');
        setUser(null);
        return;
      }
      if (!response.ok) {
        throw new Error('Unable to check login session.');
      }
      const data = await response.json();
      if (data?.authenticated && data.user) {
        setUser(data.user);
        setSenderEmail((prev) => prev || data.user.email || 'outreach@ethereal.email');
      }
    } catch (error) {
      setLoginError(
        error instanceof Error ? error.message : 'Unable to reach backend server.'
      );
    } finally {
      setAuthLoading(false);
    }
  }

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const tokenParam = params.get('token');
    const loginParam = params.get('login');
    const reasonParam = params.get('reason');
    const slackParam = params.get('slack');

    if (tokenParam) {
      localStorage.setItem('reachinbox_token', tokenParam);
    }

    if (loginParam === 'failed') {
      setLoginError(
        reasonParam ||
          'Google sign-in failed. Verify Authorized Redirect URI and Test Users in Google Cloud Console.'
      );
    }

    if (slackParam === 'connected') {
      setNotice('Slack connected! Live alerts will fire when hourly rate limits are hit.');
    } else if (slackParam === 'error') {
      setNotice('Slack connection failed or was cancelled.');
    }

    if (tokenParam || loginParam || slackParam) {
      window.history.replaceState({}, document.title, window.location.pathname);
    }

    void checkSession();
  }, []);

  async function load(silent = false) {
    if (!user) return;
    if (!silent) setLoading(true);

    try {
      const url = search.trim()
        ? `${API}/api/emails/search?q=${encodeURIComponent(search.trim())}`
        : `${API}/api/emails`;

      const response = await fetch(url, {
        credentials: 'include',
        headers: authHeaders()
      });
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Unable to load emails.');
      }

      const list = Array.isArray(data)
        ? data
        : Array.isArray(data.emails)
          ? data.emails
          : [];
      setAllEmails(list);
    } catch (error) {
      if (!silent) {
        setNotice(
          error instanceof Error ? error.message : 'Unable to load email activity.'
        );
      }
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (!user) return;
    void load();
    const timer = setInterval(() => void load(true), 3000);
    return () => clearInterval(timer);
  }, [user, search]);

  function extractEmails(text: string): string[] {
    const found = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
    return [...new Set(found.map((email) => email.trim().toLowerCase()))];
  }

  function parseFile(file?: File) {
    if (!file) return;
    setFileName(file.name);
    file.text().then((text) => {
      setFileRecipients(extractEmails(text));
    });
  }

  const combinedRecipients = [
    ...new Set([...fileRecipients, ...extractEmails(manualRecipients)])
  ];

  async function schedule() {
    setNotice('');
    try {
      const response = await fetch(`${API}/api/emails/schedule`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({
          subject,
          body,
          recipients: combinedRecipients,
          startAt: new Date(startAt).toISOString(),
          delayMs: Math.min(3600000, Math.max(0, Math.round(Number(delay) * 1000))),
          hourlyLimit: Number(limit),
          senderEmail
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.error || (data.details ? JSON.stringify(data.details) : 'Scheduling failed.')
        );
      }

      setNotice(`Successfully scheduled ${data.count ?? combinedRecipients.length} emails!`);
      setCompose(false);
      setSubject('');
      setBody('');
      setFileRecipients([]);
      setManualRecipients('');
      setFileName('');
      setTab('scheduled');
      void load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Scheduling request failed.');
    }
  }

  async function connectSlack() {
    try {
      const res = await fetch(`${API}/api/slack/connect`, {
        credentials: 'include',
        headers: authHeaders()
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start Slack OAuth');
      window.location.href = data.url;
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Slack connect failed.');
    }
  }

  async function disconnectSlack() {
    await fetch(`${API}/api/slack/disconnect`, {
      method: 'POST',
      credentials: 'include',
      headers: authHeaders()
    });
    setNotice('Slack disconnected.');
    void checkSession();
  }

  async function logout() {
    try {
      await fetch(`${API}/auth/logout`, {
        method: 'POST',
        credentials: 'include',
        headers: authHeaders()
      });
    } finally {
      localStorage.removeItem('reachinbox_token');
      setUser(null);
      setAllEmails([]);
      setNotice('');
      setLoginError('');
    }
  }

  if (authLoading) {
    return (
      <div className="shell">
        <main>
          <div className="empty">Checking your sign-in…</div>
        </main>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="shell">
        <main>
          <section
            className="panel"
            style={{
              maxWidth: 480,
              margin: '12vh auto',
              padding: 36,
              textAlign: 'center'
            }}
          >
            <div className="brandmark" style={{ margin: '0 auto 18px' }}>
              R
            </div>
            <h1>Welcome to ReachInbox</h1>
            <p>Sign in with your Google account to access your email scheduler.</p>

            <a
              className="primary"
              href={`${API}/auth/google`}
              style={{
                display: 'inline-flex',
                justifyContent: 'center',
                alignItems: 'center',
                marginTop: 24,
                padding: '12px 24px',
                textDecoration: 'none'
              }}
            >
              Continue with Google
            </a>

            {loginError && (
              <div className="error-box" style={{ marginTop: 18 }}>
                {loginError}
              </div>
            )}

            <p style={{ marginTop: 22, fontSize: 11, color: '#9298a6' }}>
              Secure Google sign-in · Backend: {API}
            </p>
          </section>
        </main>
      </div>
    );
  }

  const scheduledCount = allEmails.filter(
    (e) => e.status === 'scheduled' || e.status === 'rate_limited'
  ).length;
  const sentCount = allEmails.filter((e) => e.status === 'sent').length;
  const failedCount = allEmails.filter((e) => e.status === 'failed').length;

  const visible = allEmails.filter((email) => {
    if (tab === 'scheduled') {
      return email.status === 'scheduled' || email.status === 'rate_limited';
    }
    return email.status === tab;
  });

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brandmark">R</span>
          <span>reachinbox</span>
        </div>

        <div className="workspace">
          WORKSPACE <b>{user.name || user.email}</b>
        </div>

        <nav>
          <button
            className={tab === 'scheduled' ? 'active' : ''}
            onClick={() => setTab('scheduled')}
          >
            <CalendarClock />
            Scheduled emails ({scheduledCount})
          </button>

          <button
            className={tab === 'sent' ? 'active' : ''}
            onClick={() => setTab('sent')}
          >
            <Send />
            Sent emails ({sentCount})
          </button>

          <button
            className={tab === 'failed' ? 'active' : ''}
            onClick={() => setTab('failed')}
          >
            <X />
            Failed emails ({failedCount})
          </button>

          <a href={`${API}/admin/queues`} target="_blank" rel="noreferrer">
            <ExternalLink />
            BullMQ Queue Monitor
          </a>
        </nav>

        <div className="sidefoot">
          Email operations
          <br />
          <small>Persistent BullMQ + Redis</small>
        </div>
      </aside>

      <main>
        <header>
          <div>
            <div className="eyebrow">CAMPAIGNS / EMAILS</div>
            <h1>Email activity</h1>
            <p>Schedule, monitor and manage outbound email jobs.</p>
          </div>

          <div className="profile">
            {user.slackConnected ? (
              <div className="slack-ok">
                <Hash size={14} />
                Slack {user.slackChannel ? `(${user.slackChannel})` : 'Connected'}
                <button
                  onClick={() => void disconnectSlack()}
                  style={{
                    border: 0,
                    background: 'transparent',
                    color: '#c04c4c',
                    cursor: 'pointer',
                    fontSize: 11,
                    textDecoration: 'underline',
                    marginLeft: 4
                  }}
                >
                  Disconnect
                </button>
              </div>
            ) : (
              <button className="refresh" onClick={() => void connectSlack()}>
                <Hash size={14} />
                Connect Slack
              </button>
            )}

            {user.picture ? (
              <img className="avatar" src={user.picture} alt="" />
            ) : (
              <div className="avatar">{user.name?.[0] || 'U'}</div>
            )}

            <div>
              <b>{user.name || 'Google User'}</b>
              <small>{user.email}</small>
            </div>

            <button className="refresh" onClick={() => void logout()}>
              <LogOut size={15} />
              Logout
            </button>
          </div>
        </header>

        <section className="stats">
          <div className="stat">
            <span>Scheduled</span>
            <b>{scheduledCount}</b>
            <CalendarClock />
          </div>

          <div className="stat">
            <span>Sent</span>
            <b>{sentCount}</b>
            <CheckCircle2 />
          </div>

          <div className="stat">
            <span>Failed</span>
            <b>{failedCount}</b>
            <Clock3 />
          </div>
        </section>

        <section className="panel">
          <div className="toolbar">
            <div>
              <h2>
                {tab === 'scheduled'
                  ? 'Scheduled emails'
                  : tab === 'sent'
                    ? 'Sent emails'
                    : 'Failed emails'}
              </h2>
              <p>Review recipient-level delivery status.</p>
            </div>

            <button
              className="primary"
              onClick={() => {
                const d = new Date();
                d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
                setStartAt(d.toISOString().slice(0, 16));
                setCompose(true);
              }}
            >
              <Plus size={17} />
              Compose new email
            </button>
          </div>

          <div className="filters">
            <div className="search">
              <Search size={17} />
              <input
                placeholder="Search recipient, subject, or body..."
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>

            <button className="refresh" onClick={() => void load()}>
              Refresh
            </button>
          </div>

          {notice && <div className="notice">{notice}</div>}

          {loading ? (
            <div className="empty">Loading email activity…</div>
          ) : visible.length === 0 ? (
            <div className="empty">
              <div className="emptyicon">
                <Mail />
              </div>
              <b>No {tab} emails yet</b>
              <span>
                Compose an email and upload a CSV/TXT file or enter recipient addresses.
              </span>
            </div>
          ) : (
            <div className="tablewrap">
              <table>
                <thead>
                  <tr>
                    <th>RECIPIENT</th>
                    <th>SUBJECT</th>
                    <th>{tab === 'sent' ? 'SENT TIME' : 'SCHEDULED TIME'}</th>
                    <th>STATUS</th>
                    {tab === 'sent' && <th>ETHEREAL PREVIEW</th>}
                  </tr>
                </thead>

                <tbody>
                  {visible.map((email) => (
                    <tr key={email.id}>
                      <td>{email.recipient}</td>
                      <td>{email.subject}</td>
                      <td>
                        {new Date(email.sentAt || email.scheduledAt).toLocaleString()}
                      </td>
                      <td>
                        <span className={`pill ${email.status}`}>
                          {email.status.replace('_', ' ')}
                        </span>
                      </td>
                      {tab === 'sent' && (
                        <td>
                          {email.previewUrl ? (
                            <a
                              href={email.previewUrl}
                              target="_blank"
                              rel="noreferrer"
                              style={{ color: '#5953e8', fontWeight: 600 }}
                            >
                              Open Preview ↗
                            </a>
                          ) : (
                            '—'
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer>
          ReachInbox Scheduler
          <span>Persistent jobs · BullMQ · Redis</span>
        </footer>
      </main>

      {compose && (
        <div className="overlay">
          <div className="modal">
            <div className="modalhead">
              <div>
                <h2>Compose new email</h2>
                <p>Prepare a message and schedule recipient delivery.</p>
              </div>

              <button className="iconbtn" onClick={() => setCompose(false)}>
                <X />
              </button>
            </div>

            <label>
              Sender email
              <input
                type="email"
                value={senderEmail}
                onChange={(event) => setSenderEmail(event.target.value)}
                placeholder="outreach@ethereal.email"
              />
            </label>

            <label>
              Subject
              <input
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
                placeholder="A quick introduction"
              />
            </label>

            <label>
              Email body
              <textarea
                value={body}
                onChange={(event) => setBody(event.target.value)}
                rows={4}
                placeholder="Write your email…"
              />
            </label>

            <label className="upload">
              <Upload />
              <span>
                <b>Upload CSV or TXT leads</b>
                <small>{fileName || 'Choose a file containing email addresses'}</small>
              </span>

              <input
                type="file"
                accept=".csv,.txt,text/plain,text/csv"
                onChange={(event) => parseFile(event.target.files?.[0])}
              />
            </label>

            <label>
              Or enter/paste recipient emails
              <input
                value={manualRecipients}
                onChange={(event) => setManualRecipients(event.target.value)}
                placeholder="lead1@example.com, lead2@example.com"
              />
            </label>

            <div className="detected">
              {combinedRecipients.length} email address{combinedRecipients.length === 1 ? '' : 'es'} detected
            </div>

            <div className="two">
              <label>
                Start time
                <input
                  type="datetime-local"
                  value={startAt}
                  onChange={(event) => setStartAt(event.target.value)}
                />
              </label>

              <label>
                Delay (seconds)
                <input
                  type="number"
                  min="0"
                  max="3600"
                  value={delay}
                  onChange={(event) => setDelay(Number(event.target.value))}
                />
              </label>
            </div>

            <label>
              Hourly limit
              <input
                type="number"
                min="1"
                max="500"
                value={limit}
                onChange={(event) => setLimit(Number(event.target.value))}
              />
            </label>

            <div className="modalactions">
              <button className="refresh" onClick={() => setCompose(false)}>
                Cancel
              </button>

              <button
                className="primary"
                disabled={
                  !subject.trim() ||
                  !body.trim() ||
                  !senderEmail.trim() ||
                  !combinedRecipients.length
                }
                onClick={() => void schedule()}
              >
                Schedule {combinedRecipients.length} email{combinedRecipients.length === 1 ? '' : 's'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
