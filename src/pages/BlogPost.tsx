import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Seo } from '../components/Seo'
import { formatDate, type Post } from '../lib/posts'

export default function BlogPost({ post }: { post: Post }) {
  return (
    <>
      <Seo
        title={post.title}
        description={post.description}
        path={post.path}
        image={post.image}
        type="article"
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
          <Markdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeRaw]}>
            {post.body}
          </Markdown>
        </div>
      </article>
    </>
  )
}
