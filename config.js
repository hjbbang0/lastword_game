// 브라우저에 공개해도 되는 설정만 돌려줍니다. (Anthropic API 키는 절대 내보내지 않음)
export default function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({
    ai: Boolean(process.env.ANTHROPIC_API_KEY),
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || "",
  });
}
