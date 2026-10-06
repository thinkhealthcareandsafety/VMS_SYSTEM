import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Eye, EyeOff, ShieldCheck, Lock, Radio, AlertCircle } from 'lucide-react';
import { api } from '../api.js';
import { Logo, Spinner } from '../components/ui.jsx';

// Concentric arches: the gate, drawn once for the brand panel.
function GateArt() {
  const arches = [0, 1, 2, 3, 4, 5, 6];
  return (
    <svg className="gate" viewBox="0 0 620 620" aria-hidden="true">
      {arches.map((i) => {
        const w = 120 + i * 70;
        const x = 310 - w / 2;
        return (
          <path key={i} d={`M${x} 620 V${310 - i * 18} a${w / 2} ${w / 2} 0 0 1 ${w} 0 V620`} fill="none"
            stroke={i === 0 ? '#2fd0a2' : '#ffffff'} strokeOpacity={i === 0 ? 0.9 : 0.12 - i * 0.012} strokeWidth={i === 0 ? 2 : 1.2} />
        );
      })}
    </svg>
  );
}

export default function Login({ onLogin }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(null);

  if (done) return <Navigate to={done.role === 'admin' ? '/admin' : '/guard'} replace />;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const user = await api('/api/auth/login', { method: 'POST', body: { username: username.trim(), password } });
      onLogin(user);
      setDone(user);
    } catch (err) {
      setError(err.status === 401 ? 'That username and password do not match.' : err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth">
      <section className="auth-art">
        <Logo dark />
        <GateArt />
        <div>
          <h2>Every visitor, approved and accounted for.</h2>
          <p>Check in at the gate, get the host’s approval by SMS, and know exactly who is on site, live.</p>
        </div>
        <div className="foot">
          <span><ShieldCheck />Aadhaar masked on device</span>
          <span><Radio />Live site roster</span>
          <span><Lock />Every action audited</span>
        </div>
      </section>

      <section className="auth-form">
        <form onSubmit={submit} noValidate>
          <Logo />
          <div>
            <h1>Sign in</h1>
            <p className="lead">Use the account your site admin gave you.</p>
          </div>
          {error && <div className="alert alert-bad" role="alert"><AlertCircle /><span>{error}</span></div>}
          <label className="field">
            <span>Username</span>
            <input className="input" autoComplete="username" autoCapitalize="none" spellCheck="false" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </label>
          <label className="field">
            <span>Password</span>
            <div className="input-group">
              <input className="input" style={{ paddingLeft: 12, paddingRight: 44 }} type={show ? 'text' : 'password'} autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
              <button type="button" className="btn btn-ghost btn-sm btn-icon trail" onClick={() => setShow((s) => !s)} aria-label={show ? 'Hide password' : 'Show password'}>
                {show ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </label>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !username || !password}>
            {busy ? <><Spinner />Signing in</> : 'Sign in'}
          </button>
        </form>
      </section>
    </main>
  );
}
