import os

# app.commons.auth.deps builds Settings() when it is imported, and Settings requires these two.
# Placeholders keep the suite runnable without a .env; nothing in the tests talks to Supabase.
os.environ.setdefault("SUPABASE_URL", "http://supabase.test")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test-service-role-key")
