import { Link } from 'react-router-dom'
import { Seo } from '../components/Seo'
import { galleries, imageUrl } from '../lib/galleries'

export default function Photos() {
  // Skip alias galleries (e.g. /past-work, which mirrors /2022).
  const years = galleries.filter((g) => !g.canonicalPath)

  return (
    <div className="gallery">
      <Seo title="Photos" description="Photography by Cailin Pitt — yearly archives." path="/photos" />
      <h1>Photos</h1>
      <ul className="gallery-index">
        {years.map((g) => {
          const cover = g.images[0]
          return (
            <li key={g.path}>
              <Link to={g.path}>
                {cover && (
                  <img
                    src={imageUrl(cover.src)}
                    alt=""
                    width={cover.width}
                    height={cover.height}
                    loading="lazy"
                    decoding="async"
                  />
                )}
                <span className="gallery-index-label">{g.title}</span>
              </Link>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
