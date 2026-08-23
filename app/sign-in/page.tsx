import { redirect } from "next/navigation";
import { signIn } from "../../auth";
import { getCurrentIdentity } from "../../lib/auth/current-user";

export default async function SignInPage() {
  if (await getCurrentIdentity()) redirect("/");

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="sign-in-title">
        <p className="section-label">SpecGraph</p>
        <h1 id="sign-in-title">Keep changes and documentation connected.</h1>
        <p>
          Sign in with GitHub to open your workspace and manage the repositories
          and documentation SpecGraph watches.
        </p>
        <form
          action={async () => {
            "use server";
            await signIn("github", { redirectTo: "/" });
          }}
        >
          <button className="primary-action auth-action" type="submit">
            Continue with GitHub
          </button>
        </form>
      </section>
    </main>
  );
}
