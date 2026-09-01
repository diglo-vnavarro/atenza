// Pantalla de acceso: verde corporativo a TODA la pantalla + esfera de marca de agua, y el bloque
// de acceso en TRASLÚCIDO (glassmorphism). Es la MISMA plantilla que Diglo Recovery — los módulos
// del Hub 360 se distinguen por el color, no por el diseño.
//
// Las vías de acceso son exactamente las que ya había: Google (Workspace), entrar con correo y
// contraseña, y crear cuenta con nombre. Aquí solo cambia la presentación; nada de MFA ni de flujos
// nuevos que no exista detrás.
import { useState, type FormEvent } from 'react';
import { useAuth, signInGoogle, signInEmail, signUpEmail } from '../auth/auth.js';
import { DiglosferaMark, DiglosferaLogo } from './brand/Diglosfera.js';
import { NOMBRE_PRODUCTO, NOMBRE_COMPLETO } from '../lib/marca.js';
import './login.css';

const NARANJA = '#f5a623';
const VERSION = import.meta.env.VITE_APP_VERSION as string | undefined;

type Modo = 'inicio' | 'entrar' | 'crear';

function GoogleG({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-2.8-.4-4H24v7.3h12.1c-.2 1.9-1.6 4.8-4.5 6.7l6.9 5.3c4.1-3.8 6.6-9.4 6.6-15.3z" />
      <path fill="#34A853" d="M24 46c5.9 0 10.9-2 14.5-5.3l-6.9-5.3c-1.9 1.3-4.4 2.2-7.6 2.2-5.8 0-10.7-3.9-12.5-9.2l-7.1 5.5C8 40.3 15.4 46 24 46z" />
      <path fill="#FBBC05" d="M11.5 28.4c-.5-1.4-.8-2.9-.8-4.4s.3-3 .7-4.4l-7.1-5.5C2.9 17 2 20.4 2 24s.9 7 2.4 9.9l7.1-5.5z" />
      <path fill="#EA4335" d="M24 10.5c3.3 0 5.5 1.4 6.8 2.6l6.1-6C33.2 3.7 28.9 2 24 2 15.4 2 8 7.7 4.4 14.1l7.1 5.5C13.3 14.4 18.2 10.5 24 10.5z" />
    </svg>
  );
}
function IcoMail({ s = 16 }: { s?: number }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
}
function IcoBack({ s = 15 }: { s?: number }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>;
}
function IcoLock({ s = 18 }: { s?: number }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="4" y="10" width="16" height="10" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3" /></svg>;
}

export function Login() {
  const error = useAuth((s) => s.error);
  const setError = useAuth((s) => s.setError);
  const [modo, setModo] = useState<Modo>('inicio');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  // Las funciones de auth ya capturan el error y lo dejan en el store; aquí solo el «ocupado».
  const run = (fn: () => Promise<void>) => { setBusy(true); void fn().finally(() => setBusy(false)); };
  const ir = (m: Modo) => { setError(null); setModo(m); };
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    run(modo === 'crear' ? () => signUpEmail(email.trim(), pw, name.trim()) : () => signInEmail(email.trim(), pw));
  };

  return (
    <div className="login-full">
      {/* Esfera de marca de agua a toda la pantalla */}
      <div className="login-sphere">
        <DiglosferaMark size={820} azul="#ffffff" naranja={NARANJA} />
      </div>

      {/* Marca corporativa GRANDE — dominando la pantalla, fuera del popup */}
      <div className="login-brand-big">
        <h1 className="login-aero">{NOMBRE_PRODUCTO}</h1>
        <div className="by">
          <span className="login-aero">by</span>
          <DiglosferaLogo height={34} onDark />
        </div>
      </div>

      {/* Bloque de acceso traslúcido */}
      <div className="login-glass">
        <div className="login-glass-head">
          <div className="login-glass-badge"><IcoLock /></div>
          <div>
            <div className="t1">Acceso</div>
            <div className="t2">{NOMBRE_COMPLETO}</div>
          </div>
        </div>

        {modo === 'inicio' && (
          <>
            <p className="login-lead">
              Entra con tu <b>identidad corporativa</b>. Sesión real, auditoría y permisos activos.
            </p>
            <button className="login-btn login-btn-google" disabled={busy} onClick={() => run(signInGoogle)}>
              <GoogleG /> <span>Continuar con Google</span>
            </button>
            <div className="login-hint">Personal interno de Diglo (Workspace).</div>

            <div className="login-sep"><span>o</span></div>

            <button className="login-btn login-btn-ghost" disabled={busy} onClick={() => ir('entrar')}>
              <IcoMail /> <span>Entrar con correo</span>
            </button>
            <div className="login-hint">
              ¿Sin cuenta?{' '}
              <button type="button" className="login-link" onClick={() => ir('crear')}>Crear una</button>.
            </div>
          </>
        )}

        {modo !== 'inicio' && (
          <form onSubmit={enviar}>
            <button type="button" className="login-crumb" onClick={() => ir('inicio')}>
              <IcoBack /> Volver
            </button>
            <p className="login-lead" style={{ marginTop: 4 }}>
              {modo === 'crear' ? <>Crea tu cuenta con <b>correo y contraseña</b>.</> : <>Acceso con <b>correo y contraseña</b>.</>}
            </p>

            {modo === 'crear' && (
              <>
                <label className="login-lbl" htmlFor="lg-name">Nombre</label>
                <input id="lg-name" className="login-input" value={name} autoComplete="name" autoFocus
                  onChange={(e) => setName(e.target.value)} placeholder="Nombre y apellidos" />
              </>
            )}

            <label className="login-lbl" htmlFor="lg-email">Correo</label>
            <input id="lg-email" className="login-input" type="email" value={email} autoComplete="email"
              autoFocus={modo === 'entrar'} onChange={(e) => setEmail(e.target.value)} placeholder="tu@digloservicer.com" />

            <label className="login-lbl" htmlFor="lg-pw">Contraseña</label>
            <input id="lg-pw" className="login-input" type="password" value={pw}
              autoComplete={modo === 'entrar' ? 'current-password' : 'new-password'}
              onChange={(e) => setPw(e.target.value)} placeholder="••••••••" />

            <button className="login-btn login-btn-primary" type="submit" disabled={busy || !email || !pw}>
              {busy ? (modo === 'crear' ? 'Creando…' : 'Entrando…') : (modo === 'crear' ? 'Crear cuenta' : 'Entrar')}
            </button>

            <div className="login-hint">
              {modo === 'entrar' ? (
                <>¿Sin cuenta? <button type="button" className="login-link" onClick={() => ir('crear')}>Crear una</button>.</>
              ) : (
                <>¿Ya tienes cuenta? <button type="button" className="login-link" onClick={() => ir('entrar')}>Entrar</button>.</>
              )}
            </div>
          </form>
        )}

        {error && <div className="login-err">{error}</div>}

        <div className="login-foot">
          Acceso a través de <b>Identity Platform</b>. El alta en una instancia la aprueba su administrador.
        </div>
      </div>

      {VERSION && <div className="login-version">build {VERSION}</div>}
    </div>
  );
}
