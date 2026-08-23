import NextAuth from "next-auth";
import GitHub from "next-auth/providers/github";

export const { auth, handlers, signIn, signOut } = NextAuth({
  trustHost: true,
  secret: process.env.AUTH_SECRET,
  session: { strategy: "jwt" },
  pages: { signIn: "/sign-in" },
  providers: [
    GitHub({
      clientId: process.env.GITHUB_CLIENT_ID ?? "",
      clientSecret: process.env.GITHUB_CLIENT_SECRET ?? "",
      profile(profile) {
        return {
          id: String(profile.id),
          name: profile.name ?? profile.login,
          email:
            profile.email ??
            `${profile.id}+${profile.login}@users.noreply.github.com`,
          image: profile.avatar_url,
        };
      },
    }),
  ],
  callbacks: {
    jwt({ token, profile }) {
      if (profile?.id) token.providerUserId = String(profile.id);
      return token;
    },
    session({ session, token }) {
      if (session.user) {
        session.user.id = String(token.providerUserId ?? token.sub ?? "");
      }
      return session;
    },
  },
});
