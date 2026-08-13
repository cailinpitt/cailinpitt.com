import { useState, type ReactNode } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Link } from 'react-router-dom'
import { PostSource } from '../components/PostSource'
import { Seo } from '../components/Seo'
import { aboutPage } from '../lib/about'
import { imageUrl } from '../lib/images'
import { pageSchema } from '../lib/structuredData'

/** Where this page's own source is published — see scripts/generate-markdown.mjs. */
const SOURCE_FILE = '/about.md'

/** Keep root-relative links client-side; matches /now, /uses, and the colophon. */
const markdownComponents = {
  // Same rewrite post bodies get: /images/... is an R2 object, not a file in dist.
  img: ({ node: _node, ...props }: { node?: unknown; src?: string }) => (
    <img {...props} src={imageUrl(props.src)} />
  ),
  a: ({
    node: _node,
    href,
    children,
    ...props
  }: {
    node?: unknown
    href?: string
    children?: ReactNode
  }) =>
    href?.startsWith('/') ? (
      <Link to={href} {...props}>
        {children}
      </Link>
    ) : (
      <a href={href} {...props}>
        {children}
      </a>
    ),
}

export function Component() {
  const [showSource, setShowSource] = useState(false)

  return (
    <>
      <Seo
        title={aboutPage.title}
        description={aboutPage.description}
        path="/about"
        jsonLd={pageSchema({
          path: '/about',
          title: aboutPage.title,
          description: aboutPage.description,
        })}
        markdownPath={SOURCE_FILE}
      />
      <article className="post">
        <header className="post-header">
          <h1>{aboutPage.title}</h1>
          {aboutPage.lead && <p>{aboutPage.lead}</p>}
        </header>

        <div className="post-source-bar">
          <PostSource
            body={aboutPage.body}
            file={SOURCE_FILE}
            open={showSource}
            onToggle={setShowSource}
          />
        </div>

        {showSource ? (
          <pre className="post-source">{aboutPage.body}</pre>
        ) : (
          <div className="post-body">
            <Markdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeRaw]}
              components={markdownComponents}
            >
              {aboutPage.body}
            </Markdown>
          </div>
        )}
      </article>
    </>
  )
}
