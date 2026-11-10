'use server';
import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { str } from '@/lib/flash';

export async function signIn(_: unknown, fd: FormData): Promise<{ error?: string }> {
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ email: str(fd, 'email'), password: str(fd, 'password') });
  // generic message: do not reveal whether the account exists
  if (error) return { error: 'Sign-in failed. Check your email and password.' };
  redirect('/select-event');
}

export async function signOut() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect('/login');
}
