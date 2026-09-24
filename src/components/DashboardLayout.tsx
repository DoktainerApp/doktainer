"use client";

import { useState, useEffect } from "react";
import Sidebar from "@/components/Sidebar";
import Topbar from "@/components/Topbar";
import ReadOnlyAccessNotice from "@/components/ReadOnlyAccessNotice";
import ReadOnlyActionScope from "@/components/ReadOnlyActionScope";
import VersionUpdateNotice from "@/components/VersionUpdateNotice";
import { useCurrentUser, useRequireAuth } from "@/lib/auth-state";
import { addPreferencesListener, getStoredPanelName } from "@/lib/preferences";
import { getRoleCapabilities } from "@/lib/rbac";

interface DashboardLayoutProps {
  children: React.ReactNode;
  title: string;
  subtitle?: string;
}

export default function DashboardLayout({
  children,
  title,
  subtitle,
}: DashboardLayoutProps) {
  const isAuthenticated = useRequireAuth();
  const currentUser = useCurrentUser();
  const roleCapabilities = getRoleCapabilities(currentUser?.role);
  const [collapsed, setCollapsed] = useState(false);
  const [isMobile, setIsMobile] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    const checkMobile = () => {
      const mobile = window.innerWidth < 768;
      setIsMobile(mobile);
      if (mobile) setCollapsed(true);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  useEffect(() => {
    const syncTitle = () => {
      document.title = `${title} | ${getStoredPanelName()}`;
    };

    syncTitle();
    return addPreferencesListener(syncTitle);
  }, [title]);

  if (!isAuthenticated) {
    return null;
  }

  return (
    <div style={{ display: "flex", height: "100vh", overflow: "hidden" }}>
      {/* Floating particles */}
      <div className="particles-bg">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="particle"
            style={{
              left: `${10 + i * 12}%`,
              top: `${20 + (i % 3) * 25}%`,
              animationDelay: `${i * 0.5}s`,
              opacity: 0.15 + (i % 3) * 0.1,
              width: 3 + (i % 2) * 2,
              height: 3 + (i % 2) * 2,
            }}
          />
        ))}
      </div>

      {/* Sidebar — handles its own backdrop overlay for mobile */}
      <Sidebar
        collapsed={collapsed}
        isMobile={isMobile}
        mobileOpen={mobileOpen}
        onMobileClose={() => setMobileOpen(false)}
      />

      {/* Main content area */}
      <div
        style={{
          flex: 1,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        <Topbar
          title={title}
          subtitle={subtitle}
          onMobileMenuToggle={
            isMobile ? () => setMobileOpen(!mobileOpen) : undefined
          }
          onSidebarToggle={
            isMobile ? undefined : () => setCollapsed((value) => !value)
          }
          sidebarCollapsed={collapsed}
        />
        <main
          className="p-4 md:p-6"
          style={{
            flex: 1,
            overflowY: "auto",
            overflowX: "hidden",
            padding: 15,
          }}
        >
          <VersionUpdateNotice />
          <ReadOnlyActionScope enabled={roleCapabilities.isReadOnly}>
            {roleCapabilities.isReadOnly ? <ReadOnlyAccessNotice /> : null}
            {children}
          </ReadOnlyActionScope>
        </main>
      </div>
    </div>
  );
}
