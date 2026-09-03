import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'

export function Component() {
  return (
    <div className="not-found">
      <Seo title="Not found" path="/404" />
      <h1>Page not found</h1>
      <p>
        That page doesn’t exist. <Link to="/">Head home</Link> or browse the{' '}
        <Link to="/blog">blog</Link>.
      </p>
    </div>
  )
}
