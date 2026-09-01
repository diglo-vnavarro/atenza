// Marca Diglosfera reproducida en SVG a partir del logo oficial (balón/globo con estela de
// movimiento + banda naranja, y wordmark "DIGLOSFERA / HUB 360"). `DiglosferaMark` = solo el
// símbolo; `DiglosferaLogo` = lockup completo. `onDark` → variante en negativo (fondos oscuros).
// Copia literal del componente de Diglo Recovery: los dos módulos deben pintar la misma marca.
type MarkProps = { size?: number; azul?: string; naranja?: string };

const NARANJA = "#f5a623";
const AZUL = "#0e3f6e";

export function DiglosferaMark({ size = 32, azul = AZUL, naranja = NARANJA }: MarkProps) {
  // viewBox 120×80: estela a la izquierda + balón a la derecha.
  return (
    <svg width={(size * 120) / 80} height={size} viewBox="0 0 120 80" fill="none" aria-hidden="true"
      style={{ display: "block", flexShrink: 0 }}>
      {/* estela de movimiento */}
      <g strokeLinecap="round" strokeWidth="4">
        <line x1="8" y1="27" x2="30" y2="27" stroke={naranja} />
        <line x1="3" y1="40" x2="33" y2="40" stroke={azul} />
        <line x1="9" y1="53" x2="27" y2="53" stroke={azul} />
      </g>
      <circle cx="37" cy="27" r="2.4" fill={naranja} />
      <circle cx="33" cy="53" r="2.4" fill={azul} />
      {/* balón */}
      <g fill="none" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="80" cy="40" r="30" stroke={azul} strokeWidth="3.4" />
        {/* costuras (almendra central + banda) */}
        <path d="M80 10 C 98 22, 98 58, 80 70" stroke={azul} strokeWidth="2.4" />
        <path d="M80 10 C 62 22, 62 58, 80 70" stroke={azul} strokeWidth="2.4" />
        <path d="M52 31 C 66 40, 94 40, 108 31" stroke={azul} strokeWidth="2.4" />
        {/* envoltura naranja (órbita) */}
        <path d="M54 19 C 71 7, 97 14, 105 37" stroke={naranja} strokeWidth="4.2" />
        <path d="M55 62 C 70 72, 90 67, 101 52" stroke={naranja} strokeWidth="4.2" />
      </g>
    </svg>
  );
}

export function DiglosferaLogo({ height = 30, onDark = false }: { height?: number; onDark?: boolean }) {
  const azul = onDark ? "#eaf2fb" : AZUL;   // líneas del balón
  const txt = onDark ? "#ffffff" : AZUL;    // "DIGLOSFERA"
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: height * 0.3 }}>
      <DiglosferaMark size={height * 1.12} azul={azul} naranja={NARANJA} />
      <div className="login-aero" style={{ lineHeight: 0.9 }}>
        <div style={{ fontWeight: 700, color: txt, fontSize: height * 0.68, letterSpacing: ".02em" }}>DIGLOSFERA</div>
        <div style={{ fontWeight: 700, color: NARANJA, fontSize: height * 0.5, letterSpacing: ".2em" }}>HUB 360</div>
      </div>
    </div>
  );
}
