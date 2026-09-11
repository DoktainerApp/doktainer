"use client";

import { useEffect, useState } from "react";
import {
  getUser,
  loadCurrentSession,
  redirectToLogin,
  type UserInfo,
} from "@/lib/api";
import { addAuthStateListener } from "@/lib/auth-events";

export function useCurrentUser() {
  const [currentUser, setCurrentUser] = useState<UserInfo | null>(getUser());

  useEffect(() => {
    let active = true;
    const syncCurrentUser = (source: "local" | "broadcast") => {
      if (source === "broadcast") {
        void loadCurrentSession(true).then((user) => {
          if (active) setCurrentUser(user);
        });
        return;
      }
      setCurrentUser(getUser());
    };

    void loadCurrentSession().then((user) => {
      if (active) setCurrentUser(user);
    });
    const removeAuthStateListener = addAuthStateListener(syncCurrentUser);

    return () => {
      active = false;
      removeAuthStateListener();
    };
  }, []);

  return currentUser;
}

export function useRequireAuth() {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);

  useEffect(() => {
    let active = true;
    const syncAuth = (source: "local" | "broadcast") => {
      if (source === "broadcast") {
        void loadCurrentSession(true).then((user) => {
          if (!active) return;
          setAuthenticated(Boolean(user));
          if (!user) redirectToLogin();
        });
        return;
      }
      setAuthenticated(Boolean(getUser()));
    };

    void loadCurrentSession().then((user) => {
      if (!active) return;
      setAuthenticated(Boolean(user));
      if (!user) redirectToLogin();
    });
    const removeAuthStateListener = addAuthStateListener(syncAuth);

    return () => {
      active = false;
      removeAuthStateListener();
    };
  }, []);

  return authenticated === true;
}
