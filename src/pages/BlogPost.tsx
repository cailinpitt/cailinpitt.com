import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import { formatDate, type Post } from '../lib/posts'
import { blogPostingSchema, breadcrumbSchema } from '../lib/structuredData'

// Rewrite root-relative /images/... sources in post bodies to their R2 URLs.
const markdownComponents = {
  img: ({ node: _node, ...props }: { node?: unknown; src?: string }) => (
    <img {...props} src={imageUrl(props.src)} />
  ),
}

export default function BlogPost({ post }: { post: Post }) {
  return (
    <>
      <Seo
        title={post.title}
        description={post.description}
        path={post.path}
        image={imageUrl(post.image)}
        type="article"
        jsonLd={[blogPostingSchema(post), breadcrumbSchema(post)]}
      />
      <article className="post">
        <header className="post-header">
          <h1>{post.title}</h1>
          {post.date && (
            <time dateTime={post.date} className="post-date">
              {formatDate(post.date)}
            </time>
          )}
        </header>
        <div className="post-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {post.body}
          </Markdown>
        </div>
      </article>
    </>
  )
}
