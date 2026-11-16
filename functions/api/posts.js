export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // GET /api/posts - Fetch all posts from D1 database
    if (path.endsWith('/api/posts') || path.endsWith('/api/posts/')) {
      if (request.method === 'GET') {
        const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY scheduled_date DESC").all();
        return Response.json(results, { headers: corsHeaders });
      }

      // POST /api/posts - Create a new scheduled post or draft
      if (request.method === 'POST') {
        const body = await request.json();
        const id = 'post_' + Date.now();
        await env.DB.prepare(
          "INSERT INTO posts (id, brand_id, content, platforms, status, scheduled_date, media_url) VALUES (?, ?, ?, ?, ?, ?, ?)"
        ).bind(
          id, 
          body.brand_id || 1, 
          body.content, 
          JSON.stringify(body.platforms || []), 
          body.status || 'queue', 
          body.scheduled_date || new Date().toISOString(), 
          body.media_url || ""
        ).run();
        
        return Response.json({ success: true, id }, { headers: corsHeaders });
      }
    }

    // DELETE /api/posts/:id - Remove post
    if (path.includes('/api/posts/')) {
      const id = path.split('/').pop();
      if (request.method === 'DELETE') {
        await env.DB.prepare("DELETE FROM posts WHERE id = ?").bind(id).run();
        return Response.json({ success: true }, { headers: corsHeaders });
      }
    }

    return new Response("Not Found", { status: 404, headers: corsHeaders });
  } catch (err) {
    return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
  }
}