import React from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import App from './App.jsx';
import { ToastProvider } from './components/ui.jsx';
import './styles.css';

// A render error should never leave a guard staring at a blank page. Typed form data survives in storage.
class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(err) {
    console.error('Screen failed to render', err);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="splash">
        <div className="crash">
          <h1>Something went wrong on this screen</h1>
          <p>Nothing you entered is lost. Reload to carry on.</p>
          <button className="btn btn-primary btn-lg" onClick={() => window.location.reload()}>Reload</button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ErrorBoundary>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </React.StrictMode>,
);
