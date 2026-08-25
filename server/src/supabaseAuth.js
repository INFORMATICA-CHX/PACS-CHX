const VALID_ROLES = new Set(['master', 'admin', 'radiologist', 'technician', 'reception', 'printing', 'maintenance', 'auditor', 'viewer']);

function settings(config) {
  const url = String(process.env.SUPABASE_URL || config.supabase?.url || '').replace(/\/+$/, '');
  const anonKey = String(process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || config.supabase?.anonKey || config.supabase?.publishableKey || '');
  const enabled = Boolean(process.env.SUPABASE_URL && anonKey) || Boolean(config.supabase?.enabled && url && anonKey);
  const defaultRole = VALID_ROLES.has(config.supabase?.defaultRole) ? config.supabase.defaultRole : 'viewer';
  const emailDomain = String(process.env.SUPABASE_EMAIL_DOMAIN || config.supabase?.emailDomain || '').replace(/^@+/, '').trim().toLowerCase();
  return { enabled, url, anonKey, defaultRole, emailDomain };
}

export function supabaseAuthEnabled(config) {
  return settings(config).enabled;
}

async function fetchSupabaseProfile({ url, anonKey, accessToken, userId }) {
  if (!accessToken || !userId) return null;
  const response = await fetch(`${url}/rest/v1/profiles?id=eq.${encodeURIComponent(userId)}&select=username,display_name,role`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
      Accept: 'application/json',
    },
  });
  if (!response.ok) return null;
  const rows = await response.json().catch(() => []);
  return Array.isArray(rows) ? rows[0] ?? null : null;
}

export async function authenticateSupabaseUser(config, username, password) {
  const { enabled, url, anonKey, defaultRole, emailDomain } = settings(config);
  if (!enabled) return null;
  const login = String(username ?? '').trim();
  const isEmail = login.includes('@');
  const isPhone = /^\+?[0-9][0-9\s().-]{5,}$/.test(login);
  const email = isEmail ? login : emailDomain && !isPhone ? `${login}@${emailDomain}` : '';
  const body = email ? { email, password } : { phone: login, password };
  const response = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: anonKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(result.error_description || result.msg || result.error || 'Usuário ou senha inválidos.');

  const user = result.user ?? {};
  const profile = await fetchSupabaseProfile({ url, anonKey, accessToken: result.access_token, userId: user.id });
  const metadata = { ...(user.user_metadata ?? {}), ...(user.app_metadata ?? {}) };
  const profileRole = String(profile?.role ?? '');
  const role = VALID_ROLES.has(profileRole) ? profileRole : VALID_ROLES.has(metadata.role) ? metadata.role : defaultRole;
  const profileUsername = String(profile?.username ?? '').trim();
  const profileDisplayName = String(profile?.display_name ?? '').trim();
  const preferredUsername = profileUsername || (!isEmail && email ? login : String(metadata.username || user.email || user.phone || login));
  return {
    id: String(user.id ?? ''),
    username: preferredUsername,
    displayName: profileDisplayName || String(metadata.display_name || metadata.name || user.email || user.phone || login),
    role,
  };
}
