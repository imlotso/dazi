import { createHash } from 'node:crypto';
import { articles } from '../../src/data/articles.js';
import { articleLength } from '../../src/lib/analysis.js';
import type { AsyncDatabase } from '../database/types.js';

/** Populate a new empty catalog explicitly; never run on function startup. */
export async function seedPostgresCatalog(db: AsyncDatabase, now: () => number = Date.now) {
  if (db.dialect !== 'postgres') throw new Error('PostgreSQL catalog target required');
  const count = db.prepare('SELECT COUNT(*) AS count FROM public_articles');
  const insert = db.prepare(`INSERT INTO public_articles(id,title,author,theme,language,difficulty,text,source,status,revision,updated_at,display_order,length,search_text,content_hash)
    VALUES (@id,@title,@author,@theme,@language,@difficulty,@text,@source,'published',1,@updatedAt,@displayOrder,@length,@searchText,@hash)`);
  const group = db.prepare('INSERT INTO public_article_groups(article_id,language,difficulty) VALUES (?,?,?)');
  return db.transaction(async () => {
    if ((await count.get() as { count: number }).count !== 0) throw new Error('PostgreSQL catalog is not empty');
    for (const [displayOrder, article] of articles.entries()) {
      const text = article.content;
      await insert.run({
        ...article, text, source: JSON.stringify(article.source), updatedAt: now(), displayOrder,
        length: articleLength({ language: article.language, text }),
        searchText: [article.title, article.author, article.theme].join('\n').normalize('NFKC').toLowerCase(),
        hash: createHash('sha256').update(text.normalize('NFC').trim().replace(/\s+/gu, ' ')).digest('hex'),
      });
      await group.run(article.id, article.language, article.difficulty);
    }
    return articles.length;
  })();
}
