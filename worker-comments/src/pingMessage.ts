// No worker imports, so the site's tests can use it directly.
type CommentFields = {
  postPath: string
  name: string
  message: string
}

export interface PingMessage {
  title: string
  body: string
  click: string
}

export function commentPing(comment: CommentFields): PingMessage {
  const slug = comment.postPath.split('/').pop()
  return {
    title: `${comment.name} on ${slug}`,
    body: comment.message,
    click: `https://cailinpitt.com${comment.postPath}#comments-heading`,
  }
}
