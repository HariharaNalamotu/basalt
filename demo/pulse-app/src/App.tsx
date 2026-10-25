import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import { useAuth } from '@basalt/auth/react';
import { BasaltAuthError } from '@basalt/auth/client';
import { db, DataError } from './basalt';
import type { Row } from './basalt';
import { CLASS_INFO, dayLabel, timeLabel, upcomingSessions } from './classes';
import type { ClassType, Session } from './classes';

type Route = 'home' | 'classes' | 'bookings' | 'signin' | 'signup' | 'studio';
const ROUTES: Route[] = ['home', 'classes', 'bookings', 'signin', 'signup', 'studio'];

function useRoute(): [Route, (r: Route) => void] {
  const read = (): Route => {
    const h = window.location.hash.replace(/^#\/?/, '') as Route;
    return ROUTES.includes(h) ? h : 'home';
  };
  const [route, setRoute] = useState<Route>(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return [route, (r) => (window.location.hash = '/' + (r === 'home' ? '' : r))];
}

function Bolt() {
  return (
    <svg className="bolt" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M13.5 2 4 14h6l-1.5 8L20 9.5h-6.5L13.5 2Z" fill="currentColor" />
    </svg>
  );
}

const errText = (e: unknown) =>
  e instanceof BasaltAuthError || e instanceof DataError ? e.message : 'Something went wrong. Please try again.';

export function App() {
  const { user, loading, auth } = useAuth();
  const [route, go] = useRoute();
  const [bookings, setBookings] = useState<Row[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setLoadError(null);
      setBookings(await db.listAll('bookings'));
    } catch (e) {
      setLoadError(errText(e));
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
    else setBookings(null);
  }, [user, refresh]);

  const needsAuth = route === 'bookings' || route === 'studio';
  useEffect(() => {
    if (!loading && !user && needsAuth) go('signin');
    if (!loading && user && (route === 'signin' || route === 'signup')) go('classes');
  }, [loading, user, route]); // eslint-disable-line react-hooks/exhaustive-deps

  const link = (r: Route, label: string) => (
    <a href={'#/' + (r === 'home' ? '' : r)} aria-current={route === r ? 'page' : undefined}>
      {label}
    </a>
  );

  let page: ReactNode;
  if (loading) page = <div className="container section" aria-busy="true"><p className="muted">Loading…</p></div>;
  else if (route === 'home') page = <Home signedIn={!!user} />;
  else if (route === 'classes')
    page = <Classes signedIn={!!user} bookings={bookings} email={user?.email} onChanged={refresh} loadError={loadError} />;
  else if (route === 'bookings') page = <MyBookings bookings={bookings} onChanged={refresh} loadError={loadError} />;
  else if (route === 'studio') page = <Studio bookings={bookings} loadError={loadError} />;
  else if (route === 'signin') page = <SignIn />;
  else page = <SignUp />;

  return (
    <>
      <a className="skip" href="#main">Skip to content</a>
      <header className="site-header">
        <div className="container header-inner">
          <a className="wordmark" href="#/" aria-label="Pulse home">
            <Bolt /> PULSE
          </a>
          <nav aria-label="Main" className="nav">
            {link('classes', 'Classes')}
            {user && link('bookings', 'My bookings')}
            {user ? (
              <button className="btn secondary small" onClick={() => void auth.signOut().then(() => go('home'))}>
                Sign out
              </button>
            ) : (
              <>
                {link('signin', 'Sign in')}
                <a className="btn small" href="#/signup">Join Pulse</a>
              </>
            )}
          </nav>
        </div>
      </header>
      <main id="main">{page}</main>
      <footer className="site-footer">
        <div className="container footer-inner">
          <strong>Pulse</strong>
          <span>Spin · Yoga · Boxing</span>
          {user && <a href="#/studio">Studio view: all bookings</a>}
        </div>
      </footer>
    </>
  );
}

function Home({ signedIn }: { signedIn: boolean }) {
  return (
    <>
      <section className="hero-wrap">
        <div className="container hero">
          <p className="eyebrow">Spin · Yoga · Boxing</p>
          <h1>Find your pulse.</h1>
          <p className="lead">Small classes, big energy. Grab your spot in seconds and see everything you've booked in one place.</p>
          <ul className="stats" aria-label="Pulse at a glance">
            <li><strong>3</strong> class types</li>
            <li><strong>10–15</strong> spots per class</li>
            <li><strong>1 tap</strong> to book</li>
          </ul>
          <div className="hero-actions">
            <a className="btn lime" href={signedIn ? '#/classes' : '#/signup'}>{signedIn ? 'Book a class' : 'Join Pulse'}</a>
            <a className="btn ghost" href="#/classes">See the timetable</a>
          </div>
        </div>
      </section>
      <section className="container section">
        <h2>Pick your thing</h2>
        <div className="types">
          {(Object.keys(CLASS_INFO) as ClassType[]).map((t) => (
            <article key={t} className={'type-card ' + t}>
              <h3>{CLASS_INFO[t].name}</h3>
              <p>{CLASS_INFO[t].blurb}</p>
              <p className="meta">{CLASS_INFO[t].minutes} min · only {CLASS_INFO[t].spots} spots</p>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function Classes(props: {
  signedIn: boolean;
  bookings: Row[] | null;
  email?: string;
  onChanged: () => Promise<void>;
  loadError: string | null;
}) {
  const sessions = useMemo(() => upcomingSessions(14), []);
  const [filter, setFilter] = useState<ClassType | 'all'>('all');
  const [busy, setBusy] = useState<string | null>(null);
  const [full, setFull] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [confirmed, setConfirmed] = useState<{ session: Session; spot: number } | null>(null);
  const closeConfirm = useCallback(() => setConfirmed(null), []);

  const mine = new Map((props.bookings ?? []).map((b) => [b.class_key as string, b]));
  const shown = sessions.filter((s) => filter === 'all' || s.type === filter);
  const byDay = new Map<string, Session[]>();
  for (const s of shown) {
    const k = dayLabel(s.startsAt);
    byDay.set(k, [...(byDay.get(k) ?? []), s]);
  }

  async function book(s: Session) {
    if (busy) return;
    setBusy(s.key);
    setMsg(null);
    const cap = CLASS_INFO[s.type].spots;
    try {
      // The database allows each spot number to be taken once, so the class can never go over its limit.
      for (let spot = 1; spot <= cap; spot++) {
        try {
          await db.create('bookings', {
            class_key: s.key,
            class_type: s.type,
            starts_at: s.startsAt.toISOString(),
            spot,
            member_email: props.email,
          });
          await props.onChanged();
          setConfirmed({ session: s, spot });
          return;
        } catch (e) {
          if (e instanceof DataError && e.code === 'conflict') continue;
          throw e;
        }
      }
      setFull((f) => new Set(f).add(s.key));
      setMsg({ kind: 'error', text: `Sorry, ${CLASS_INFO[s.type].name} on ${dayLabel(s.startsAt)} at ${timeLabel(s.startsAt)} is full. Try another time.` });
    } catch (e) {
      setMsg({ kind: 'error', text: `We couldn't save your booking. ${errText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="container section">
      <h1>Classes</h1>
      <p className="muted lede">The next two weeks. Every class is small, with a fixed number of spots.</p>
      <div className="chips" role="group" aria-label="Filter by class type">
        {(['all', 'spin', 'yoga', 'boxing'] as const).map((f) => (
          <button key={f} className="chip" aria-pressed={filter === f} onClick={() => setFilter(f)}>
            {f === 'all' ? 'All' : CLASS_INFO[f].name}
          </button>
        ))}
      </div>
      {msg && (
        <div className={'message ' + msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>
          {msg.text} {msg.kind === 'success' && <a href="#/bookings">View my bookings</a>}
        </div>
      )}
      {props.loadError && <div className="message error" role="alert">We couldn't load your bookings. {props.loadError}</div>}
      {!props.signedIn && (
        <div className="message">
          <a href="#/signup">Create a free account</a> or <a href="#/signin">sign in</a> to book a spot.
        </div>
      )}
      {confirmed && <Confirmation {...confirmed} onClose={closeConfirm} />}
      {[...byDay.entries()].map(([day, list]) => (
        <section key={day} className="day">
          <h2>{day}</h2>
          <ul className="class-list">
            {list.map((s) => {
              const info = CLASS_INFO[s.type];
              const booking = mine.get(s.key);
              const isFull = full.has(s.key);
              return (
                <li key={s.key} className={'class-row ' + s.type}>
                  <div className="time">{timeLabel(s.startsAt)}</div>
                  <div className="what">
                    <h3>{info.name}</h3>
                    <p className="meta">{info.minutes} min</p>
                    <p className="capacity">
                      <span className="dots" aria-hidden="true">
                        {Array.from({ length: info.spots }, (_, i) => <i key={i} />)}
                      </span>
                      <span>{info.spots} spots in total</span>
                    </p>
                  </div>
                  <div className="act">
                    {booking ? (
                      <span className="badge success">Booked · {info.unit} {String(booking.spot)}</span>
                    ) : isFull ? (
                      <span className="badge error">Class full</span>
                    ) : props.signedIn ? (
                      <button className="btn" disabled={busy !== null} onClick={() => void book(s)}>
                        {busy === s.key ? 'Booking…' : 'Book my spot'}
                      </button>
                    ) : (
                      <a className="btn secondary" href="#/signin">Sign in to book</a>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}

function Confirmation(props: { session: Session; spot: number; onClose: () => void }) {
  const { session: s, spot, onClose } = props;
  const info = CLASS_INFO[s.type];
  const headingRef = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    headingRef.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="overlay" onClick={onClose}>
      <div className={'confirm-card ' + s.type} role="dialog" aria-modal="true" aria-labelledby="confirm-title" onClick={(e) => e.stopPropagation()}>
        <p className="eyebrow">Booking confirmed</p>
        <h2 id="confirm-title" ref={headingRef} tabIndex={-1}>You're in!</h2>
        <div className="spot-badge">
          <span className="spot-unit">{info.unit}</span>
          <span className="spot-num">{spot}</span>
        </div>
        <p className="confirm-what">{info.name}</p>
        <p className="confirm-when">{dayLabel(s.startsAt)} · {timeLabel(s.startsAt)}</p>
        <div className="confirm-actions">
          <a className="btn lime" href="#/bookings">View my bookings</a>
          <button className="btn ghost" onClick={onClose}>Keep browsing</button>
        </div>
      </div>
    </div>
  );
}

function MyBookings(props: { bookings: Row[] | null; onChanged: () => Promise<void>; loadError: string | null }) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  if (props.loadError) return <div className="container section"><div className="message error" role="alert">We couldn't load your bookings. {props.loadError}</div></div>;
  if (!props.bookings)
    return <div className="container section" aria-busy="true"><h1>My bookings</h1><div className="skeleton tall" aria-hidden="true" /><p className="sr-only" role="status">Loading your bookings</p></div>;

  const now = Date.now();
  const sorted = [...props.bookings].sort((a, b) => +new Date(a.starts_at as string) - +new Date(b.starts_at as string));
  const upcoming = sorted.filter((b) => +new Date(b.starts_at as string) > now);
  const past = sorted.filter((b) => +new Date(b.starts_at as string) <= now).reverse();

  async function cancel(b: Row) {
    setBusy(b.id);
    try {
      await db.archive('bookings', b.id);
      await props.onChanged();
      setConfirming(null);
      setMsg({ kind: 'success', text: 'Booking cancelled. Your spot is free for someone else.' });
    } catch (e) {
      setMsg({ kind: 'error', text: `We couldn't cancel that booking. ${errText(e)}` });
    } finally {
      setBusy(null);
    }
  }

  const item = (b: Row, canCancel: boolean) => {
    const d = new Date(b.starts_at as string);
    const info = CLASS_INFO[b.class_type as ClassType];
    return (
      <li key={b.id} className={'booking ' + b.class_type}>
        <div>
          <h3>{info?.name ?? String(b.class_type)}</h3>
          <p>{dayLabel(d)} · {timeLabel(d)}</p>
          <p className="muted">{info?.unit ?? 'spot'} {String(b.spot)}</p>
        </div>
        {canCancel &&
          (confirming === b.id ? (
            <div className="confirm">
              <span>Cancel this booking?</span>
              <button className="btn danger" disabled={busy === b.id} onClick={() => void cancel(b)}>
                {busy === b.id ? 'Cancelling…' : 'Yes, cancel'}
              </button>
              <button className="btn secondary" onClick={() => setConfirming(null)}>Keep it</button>
            </div>
          ) : (
            <button className="btn secondary" onClick={() => setConfirming(b.id)}>Cancel</button>
          ))}
      </li>
    );
  };

  return (
    <div className="container account section">
      <h1>My bookings</h1>
      {msg && <div className={'message ' + msg.kind} role={msg.kind === 'error' ? 'alert' : 'status'}>{msg.text}</div>}
      <h2>Coming up</h2>
      {upcoming.length ? (
        <ul className="booking-list">{upcoming.map((b) => item(b, true))}</ul>
      ) : (
        <div className="empty">
          <h3>Nothing booked yet</h3>
          <p>Pick a class and grab your spot.</p>
          <a className="btn" href="#/classes">Browse classes</a>
        </div>
      )}
      {past.length > 0 && (
        <>
          <h2>Past classes</h2>
          <ul className="booking-list past">{past.map((b) => item(b, false))}</ul>
        </>
      )}
    </div>
  );
}

function Studio({ bookings, loadError }: { bookings: Row[] | null; loadError: string | null }) {
  if (loadError) return <div className="container section"><div className="message error" role="alert">{loadError}</div></div>;
  if (!bookings) return <div className="container section" aria-busy="true"><p className="muted">Loading…</p></div>;
  const groups = new Map<string, Row[]>();
  for (const b of bookings) groups.set(b.class_key as string, [...(groups.get(b.class_key as string) ?? []), b]);
  const entries = [...groups.entries()].sort(
    (a, b) => +new Date(a[1][0].starts_at as string) - +new Date(b[1][0].starts_at as string),
  );
  return (
    <div className="container account section">
      <h1>All bookings</h1>
      <p className="muted">For the studio owner: every member's booking, class by class. Members only ever see their own.</p>
      {entries.length === 0 && <div className="empty"><h3>No bookings yet</h3><p>They'll show up here as members book.</p></div>}
      {entries.map(([key, list]) => {
        const d = new Date(list[0].starts_at as string);
        const info = CLASS_INFO[list[0].class_type as ClassType];
        return (
          <section key={key} className="card studio-card">
            <h2>{info?.name} · {dayLabel(d)} · {timeLabel(d)}</h2>
            <p className="muted">{list.length} of {info?.spots} spots taken</p>
            <ul className="plain">
              {list.sort((a, b) => Number(a.spot) - Number(b.spot)).map((b) => (
                <li key={b.id}>{info?.unit} {String(b.spot)}: {String(b.member_email ?? 'member')}</li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function AuthShell(props: { title: string; children: ReactNode }) {
  return (
    <div className="container auth">
      <div className="card raised">
        <h1>{props.title}</h1>
        {props.children}
      </div>
    </div>
  );
}

function SignIn() {
  const { auth } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.signIn({ email, password });
      window.location.hash = '/classes';
    } catch (err) {
      setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Welcome back">
      <form className="stack" onSubmit={submit}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="control" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="control" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        </div>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="muted">New to Pulse? <a href="#/signup">Create an account</a></p>
      </form>
    </AuthShell>
  );
}

function SignUp() {
  const { auth } = useAuth();
  const [step, setStep] = useState<'form' | 'code'>('form');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await auth.signUp({ email, password });
      if (r.status === 'verification_required') setStep('code');
      else window.location.hash = '/classes';
    } catch (err) {
      setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await auth.verifySignUp({ code });
      window.location.hash = '/classes';
    } catch (err) {
      setError(err instanceof BasaltAuthError ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (step === 'code')
    return (
      <AuthShell title="Check your email">
        <form className="stack" onSubmit={submitCode}>
          <p>Enter the 6-digit code sent to {email}.</p>
          <div className="field">
            <label htmlFor="code">6-digit code</label>
            <input id="code" className="control code" type="text" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </div>
          {error && <div className="message error" role="alert">{error}</div>}
          <button className="btn" disabled={busy}>{busy ? 'Checking…' : 'Confirm my account'}</button>
          <button type="button" className="btn secondary" onClick={() => void auth.resendSignUpCode().catch(() => setError('Could not resend the code yet. Please wait a moment.'))}>Resend code</button>
          <button type="button" className="linklike" onClick={() => setStep('form')}>Change email</button>
        </form>
      </AuthShell>
    );

  return (
    <AuthShell title="Join Pulse">
      <form className="stack" onSubmit={submitForm}>
        <div className="field">
          <label htmlFor="email">Email</label>
          <input id="email" className="control" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <input id="password" className="control" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required aria-describedby="pw-hint" />
          <span id="pw-hint" className="hint">At least 10 characters.</span>
        </div>
        {error && <div className="message error" role="alert">{error}</div>}
        <button className="btn" disabled={busy}>{busy ? 'Creating…' : 'Create my account'}</button>
        <p className="muted">Already a member? <a href="#/signin">Sign in</a></p>
      </form>
    </AuthShell>
  );
}
