export interface Credentials { email: string; password: string; }

export function loginHandler(creds: Credentials) {
  const user = findUser(creds.email);
  if (!user) throw new Error("no such user");
  return { token: sign(user.id) };
}

function findUser(email: string) { return { id: "1", email }; }
function sign(id: string) { return `token-${id}`; }
