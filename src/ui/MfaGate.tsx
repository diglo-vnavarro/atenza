// Gate de enrolamiento del 2º factor (TOTP) para usuarios externos (email/contraseña).
// Se muestra a pantalla completa DESPUÉS de autenticar, cuando el usuario entró por email y
// aún no tiene 2º factor: la app no deja usarse hasta enrolar (el alta de cuenta y las sesiones
// abiertas sin MFA pasan por aquí). Misma estética que la pantalla de acceso.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import QRCode from 'qrcode';
import { useAuth, completarEnrol, doSignOut, sendVerification, reloadUser } from '../auth/auth.js';
import { DiglosferaMark } from './brand/Diglosfera.js';
import { NOMBRE_PRODUCTO } from '../lib/marca.js';
import './login.css';

const NARANJA = '#f5a623';

function IcoShield({ s = 18 }: { s?: number }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" /><path d="m9 12 2 2 4-4" /></svg>;
}
function IcoMail({ s = 18 }: { s?: number }) {
  return <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></svg>;
}

/** Gate de verificación de correo (Firebase exige email verificado antes de enrolar el 2º factor). */
export function VerifyEmailGate({ email, onVerified }: { email: string | null; onVerified: () => void }) {
  const error = useAuth((s) => s.error);
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [notYet, setNotYet] = useState(false);
  const auto = useRef(false);

  useEffect(() => { if (auto.current) return; auto.current = true; void sendVerification().then((ok) => setSent(ok)); }, []);

  const reenviar = async () => { setBusy(true); const ok = await sendVerification(); setBusy(false); setSent(ok); };
  const comprobar = async () => {
    setChecking(true); setNotYet(false);
    await reloadUser();
    setChecking(false);
    // onVerified re-evalúa el gate; si sigue sin verificar, el gate vuelve a 'verify'.
    onVerified(); setNotYet(true); setTimeout(() => setNotYet(false), 4000);
  };

  return (
    <div className="login-full">
      <div className="login-sphere"><DiglosferaMark size={820} azul="#ffffff" naranja={NARANJA} /></div>
      <div className="login-glass">
        <div className="login-glass-head">
          <div className="login-glass-badge"><IcoMail /></div>
          <div>
            <div className="t1">Verifica tu correo</div>
            <div className="t2">{NOMBRE_PRODUCTO}</div>
          </div>
        </div>
        <p className="login-lead">
          Te hemos enviado un enlace de verificación a <b>{email}</b>. Ábrelo para confirmar tu correo;
          es el paso previo a activar la verificación en dos pasos.
        </p>
        {sent && <div className="login-hint" style={{ marginBottom: 8 }}>Correo de verificación enviado ✓. Revisa también spam.</div>}
        <button className="login-btn login-btn-primary" disabled={checking} onClick={() => void comprobar()}>
          {checking ? 'Comprobando…' : 'Ya lo he verificado'}
        </button>
        {notYet && <div className="login-hint" style={{ marginTop: 8 }}>Aún no consta verificado. Abre el enlace del correo y reintenta.</div>}
        <div className="login-hint" style={{ marginTop: 12 }}>
          ¿No te ha llegado?{' '}
          <button type="button" className="login-link" disabled={busy} onClick={() => void reenviar()}>Reenviar</button>
          {' · '}
          <button type="button" className="login-link" onClick={() => void doSignOut()}>Salir</button>
        </div>
        {error && <div className="login-err">{error}</div>}
      </div>
    </div>
  );
}

export function MfaEnrollGate({ data, email, onEnrolled }: {
  data: { qrUrl: string; secretKey: string }; email: string | null; onEnrolled: () => void;
}) {
  const error = useAuth((s) => s.error);
  const [img, setImg] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => { void QRCode.toDataURL(data.qrUrl, { margin: 1, width: 208 }).then(setImg).catch(() => setImg('')); }, [data.qrUrl]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const ok = await completarEnrol(code);
    setBusy(false);
    if (ok) onEnrolled(); else setCode('');
  };
  const copy = () => { void navigator.clipboard?.writeText(data.secretKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); };

  return (
    <div className="login-full">
      <div className="login-sphere"><DiglosferaMark size={820} azul="#ffffff" naranja={NARANJA} /></div>
      <div className="login-glass">
        <div className="login-glass-head">
          <div className="login-glass-badge"><IcoShield /></div>
          <div>
            <div className="t1">Verificación en dos pasos</div>
            <div className="t2">{NOMBRE_PRODUCTO}</div>
          </div>
        </div>
        <p className="login-lead">
          Protege tu cuenta{email ? <> (<b>{email}</b>)</> : ''} con un <b>segundo factor</b>. Escanea el código con tu
          app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) e introduce el código.
        </p>
        {img && <div style={{ display: 'flex', justifyContent: 'center', margin: '4px 0 10px' }}>
          <img src={img} alt="Código QR para la app de autenticación" width={168} height={168}
            style={{ borderRadius: 12, background: '#fff', padding: 8 }} />
        </div>}
        <div className="login-hint" style={{ textAlign: 'center', marginBottom: 10 }}>
          ¿No puedes escanear? Clave manual:{' '}
          <button type="button" className="login-link" onClick={copy} title="Copiar" style={{ fontFamily: 'monospace' }}>
            {data.secretKey}
          </button>{copied ? ' ✓ copiada' : ''}
        </div>
        <form onSubmit={submit}>
          <label className="login-lbl" htmlFor="mfa-code">Código de 6 dígitos</label>
          <input id="mfa-code" className="login-input" inputMode="numeric" autoComplete="one-time-code" autoFocus
            maxLength={6} value={code} placeholder="000000"
            onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
          <button className="login-btn login-btn-primary" type="submit" disabled={busy || code.length < 6}>
            {busy ? 'Activando…' : 'Activar la verificación'}
          </button>
        </form>
        {error && <div className="login-err">{error}</div>}
        <div className="login-hint" style={{ marginTop: 12 }}>
          <button type="button" className="login-link" onClick={() => void doSignOut()}>Salir</button>
        </div>
        <div className="login-foot">La verificación en dos pasos es obligatoria para el acceso externo.</div>
      </div>
    </div>
  );
}
