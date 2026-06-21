import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeRaw from 'rehype-raw'
import { Seo } from '../components/Seo'
import { imageUrl } from '../lib/images'
import { projectsPage } from '../lib/projects'
import { pageSchema } from '../lib/structuredData'

// Rewrite root-relative /images/... sources to their R2 URLs (matches BlogPost).
const markdownComponents = {
  img: ({ node: _node, ...props }: { node?: unknown; src?: string }) => (
    <img {...props} src={imageUrl(props.src)} />
  ),
}

export function Component() {
  return (
    <>
      <Seo
        title={projectsPage.title}
        description={projectsPage.description}
        path="/projects"
        jsonLd={pageSchema({
          path: '/projects',
          title: projectsPage.title,
          description: projectsPage.description,
          type: 'CollectionPage',
        })}
      />
      <article className="post">
        <header className="post-header">
          <h1>{projectsPage.title}</h1>
        </header>
        <div className="post-body">
          <Markdown
            remarkPlugins={[remarkGfm]}
            rehypePlugins={[rehypeRaw]}
            components={markdownComponents}
          >
            {projectsPage.body}
          </Markdown>
        </div>
      </article>
    </>
  )
}
