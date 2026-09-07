import type { ErrorInfo, ReactNode } from 'react'
import { Component } from 'react'
import { Button } from '@renderer/components/ui'
import './common.css'

interface Props {
  children: ReactNode
  /** Shown instead of the default message */
  label?: string
}

interface State {
  error?: Error
}

/** Keeps a crashing pane from taking down the whole window. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = {}

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[estuary] render error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    return (
      <div className="cm-error">
        <div className="cm-error__title">{this.props.label ?? 'Something went wrong'}</div>
        <pre className="cm-error__detail">{error.message}</pre>
        <Button variant="secondary" onClick={() => this.setState({ error: undefined })}>
          Try again
        </Button>
      </div>
    )
  }
}
