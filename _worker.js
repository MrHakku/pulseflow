// ==========================================
    // ROUTE 1: Linked Social Accounts & OAuth Popups
    // ==========================================
    if (path.startsWith('/api/accounts')) {
      try {
        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'GET') {
          const { results } = await env.DB.prepare(
            'SELECT platform, account_name, account_id, connected_at FROM accounts ORDER BY connected_at DESC'
          ).all();
          return Response.json(results || [], { headers: corsHeaders });
        }

        // Manual or Callback account linking save
        if ((path === '/api/accounts' || path === '/api/accounts/') && request.method === 'POST') {
          const { platform, account_name, account_id, access_token } = await request.json();

          if (!platform || !account_name || !account_id || !access_token) {
            return Response.json(
              { error: 'Platform, Account Name, ID, and Access Token are required.' },
              { status: 400, headers: corsHeaders }
            );
          }

          await env.DB.prepare(
            `INSERT INTO accounts (platform, account_name, account_id, access_token, connected_at)
             VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
             ON CONFLICT(platform) DO UPDATE SET
               account_name = excluded.account_name,
               account_id = excluded.account_id,
               access_token = excluded.access_token,
               connected_at = CURRENT_TIMESTAMP`
          )
            .bind(platform.toLowerCase(), account_name.trim(), account_id.trim(), access_token.trim())
            .run();

          return Response.json({ success: true }, { headers: corsHeaders });
        }

        if (request.method === 'DELETE') {
          const platform = path.split('/').pop().toLowerCase();
          await env.DB.prepare('DELETE FROM accounts WHERE platform = ?').bind(platform).run();
          return Response.json({ success: true }, { headers: corsHeaders });
        }
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500, headers: corsHeaders });
      }
    }

    // OAuth Popup Initiation Routes
    if (path.startsWith('/api/auth/')) {
      const platform = path.split('/')[3];
      const redirectUri = `${url.origin}/api/auth/${platform}/callback`;

      if (platform === 'instagram' || platform === 'facebook') {
        const clientId = env.META_CLIENT_ID || 'YOUR_META_CLIENT_ID';
        const scope = 'instagram_basic,instagram_content_publish,pages_show_list';
        const authUrl = `https://www.facebook.com/v21.0/dialog/oauth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${scope}&response_type=token`;
        return Response.redirect(authUrl, 302);
      }

      if (platform === 'youtube') {
        const clientId = env.GOOGLE_CLIENT_ID || 'YOUR_GOOGLE_CLIENT_ID';
        const scope = 'https://www.googleapis.com/auth/youtube.upload';
        const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}&scope=${encodeURIComponent(scope)}&response_type=token`;
        return Response.redirect(authUrl, 302);
      }
    }

    // OAuth Popup Callback / Token Receiver HTML
    if (path.includes('/callback')) {
      const html = `<!DOCTYPE html>
      <html>
      <head><title>Authentication Success</title></head>
      <body style="background:#090d16;color:#fff;font-family:sans-serif;text-align:center;padding-top:50px;">
        <h2>Authorizing account...</h2>
        <script>
          // Extract token from hash or query params returned by OAuth provider
          const hash = window.location.hash.substring(1);
          const params = new URLSearchParams(hash || window.location.search);
          const accessToken = params.get('access_token') || params.get('code');

          if (accessToken) {
            // Send token back to parent window opener
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_SUCCESS', token: accessToken }, '*');
              window.close();
            } else {
              document.body.innerHTML = "<h3>Authorized! You can close this window.</h3>";
            }
          } else {
            document.body.innerHTML = "<h3>Authorization failed or token missing. Please try again.</h3>";
          }
        </script>
      </body>
      </html>`;
      return new Response(html, { headers: { 'Content-Type': 'text/html' } });
    }
