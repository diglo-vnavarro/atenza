import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  children: ReactNode;
  /** 'page' = fallback a pantalla completa (raíz de la app); 'inline' = tarjeta embebida (una vista/visual). */
  variant?: 'page' | 'inline';
  /** Etiqueta para el log: identifica qué zona falló. */
  label?: string;
  /** Mensaje del fallback (por defecto, uno genérico). */
  message?: string;
};

type State = { error: Error | null };

/** Contiene un fallo de render de su subárbol: en vez de que React desmonte todo
 *  el árbol (pantalla en blanco), muestra un fallback con opción de recargar. Así
 *  un único visual con un bug no tumba toda la aplicación. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Registro para diagnóstico (qué zona falló + traza de componentes).
    console.error(`[ErrorBoundary${this.props.label ? ` · ${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    const msg = this.props.message ?? 'Algo ha fallado al mostrar esta vista — recargar';

    if ((this.props.variant ?? 'inline') === 'page') {
      return (
        <div className="login-wrap"><div className="login-card" style={{ textAlign: 'center' }}>
          <div className="brand" style={{ justifyContent: 'center', fontSize: 20 }}><span className="glyph">A</span> Atenza</div>
          <p style={{ margin: '16px 0', color: 'var(--ink-soft)', fontSize: 14 }}>{msg}</p>
          <button className="primary" onClick={() => window.location.reload()}>Recargar</button>
        </div></div>
      );
    }

    return (
      <div style={{ margin: 16, padding: '20px 18px', border: '1px solid var(--line)', borderRadius: 12, background: 'var(--surface)', textAlign: 'center' }}>
        <p style={{ color: 'var(--ink-soft)', fontSize: 14, margin: '0 0 14px' }}>⚠ {msg}</p>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
          <button className="primary" onClick={() => window.location.reload()}>Recargar</button>
          <button className="ghost" onClick={this.reset}>Reintentar</button>
        </div>
      </div>
    );
  }
}
