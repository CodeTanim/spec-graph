import { signOut } from "../auth";

export function SignOutButton() {
  return (
    <form
      className="sign-out-form"
      action={async () => {
        "use server";
        await signOut({ redirectTo: "/sign-in" });
      }}
    >
      <button type="submit" className="sign-out-action">
        Log out
      </button>
    </form>
  );
}
