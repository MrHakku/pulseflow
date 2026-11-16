export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 1. API: Posts Management
    if (path === '/api/posts') {
      if (request.method === 'GET') {
        try {
          const { results } = await env.DB.prepare("SELECT * FROM posts ORDER BY created_at DESC").all();
          return Response.json(results);
        } catch (err) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }
      if (request.method === 'POST') {
        try {
          const body = await request.json();
          const id = crypto.randomUUID();
          await env.DB.prepare(
            "INSERT INTO posts (id, content, platforms, scheduled_date, status) VALUES (?, ?, ?, ?, ?)"
          ).bind(id, body.content, JSON.stringify(body.platforms), body.scheduled_date, body.status || 'queue').run();
          return Response.json({ success: true, id });
        } catch (err) {
          return Response.json({ error: err.message }, { status: 500 });
        }
      }
    }

    // 2. API: Workers AI Generation (Images / Text)
    if (path === '/api/ai/generate' && request.method === 'POST') {
      try {
        const { prompt, type } = await request.json();
        if (type === 'image') {
          const response = await env.AI.run('@cf/stabilityai/stable-diffusion-xl-base-1.0', {
            prompt: prompt,
            num_steps: 20,
            width: 1024,
            height: 1024
          });
          return new Response(response, { headers: { 'Content-Type': 'image/png' } });
        } else {
          const response = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
            messages: [{ role: 'user', content: prompt }]
          });
          return Response.json(response);
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // 3. Static Assets & HTML Routing (Fallback to public assets)
    try {
      // Clean up clean URL routing for static HTML pages
      let assetRequest = request;
      if (path === '/privacypolicy') {
        assetRequest = new Request(new URL('/privacypolicy.html', request.url), request);
      } else if (path === '/terms') {
        assetRequest = new Request(new URL('/terms.html', request.url), request);
      }
      
      const assetResponse = await env.ASSETS.fetch(assetRequest);
      if (assetResponse.status404 && path !== '/') {
        // Fallback to index.html for SPA routing if needed
        return env.ASSETS.fetch(new Request(new URL('/', request.url), request));
      }
      return assetResponse;
    } catch (e) {
      return new Response("Not Found", { status: 404 });
    }
  }
};