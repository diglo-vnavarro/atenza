import { useState } from 'react';
import { useAuth, signInGoogle, signInEmail, signUpEmail } from '../auth/auth.js';

export function Login() {
  const error = useAuth((s) => s.error);
  const [mode, setMode] = useState<'in' | 'up'>('in');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [name, setName] = useState('');
  const submit = () => {
    if (mode === 'in') signInEmail(email.trim(), pw);
    else signUpEmail(email.trim(), pw, name.trim());
  };
  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="brand" style={{ justifyContent: 'center', fontSize: 20 }}><span className="glyph">A</span> Atenza</div>
        <p style={{ textAlign: 'center', color: 'var(--ink-faint)', fontSize: 13, margin: '4px 0 18px' }}>Mesa de servicio</p>

        <button className="gbtn" onClick={signInGoogle}>Entrar con Google</button>
        <div className="sep"><span>o con tu correo</span></div>

        <div className="form">
          {mode === 'up' && <label>Nombre<input value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" /></label>}
          <label>Correo<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" /></label>
          <label>Contraseña<input type="password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && submit()} autoComplete={mode === 'in' ? 'current-password' : 'new-password'} /></label>
          {error && <div className="login-err">{error}</div>}
          <button className="primary" onClick={submit} disabled={!email || !pw}>{mode === 'in' ? 'Entrar' : 'Crear cuenta'}</button>
        </div>

        <p style={{ textAlign: 'center', fontSize: 12.5, color: 'var(--ink-soft)', marginTop: 14 }}>
          {mode === 'in' ? '¿No tienes cuenta? ' : '¿Ya tienes cuenta? '}
          <button className="linkbtn" onClick={() => setMode(mode === 'in' ? 'up' : 'in')}>{mode === 'in' ? 'Crear una' : 'Entrar'}</button>
        </p>
      </div>
    </div>
  );
}
