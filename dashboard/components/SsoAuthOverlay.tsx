import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface SsoConfig {
    enabled: boolean;
    button_text: string;
    hide_password_login: boolean;
    redirect_url: string;
}

// Emergency escape hatch: ?auto_sso=0 on the login page disables the
// automatic redirect only - the SSO button is always shown regardless, this
// just stops it from firing on its own and re-enables the classic form. For
// when the IdP is down, misconfigured, or otherwise locking everyone out.
// Not a new security bypass: "hide password login" is only ever a UI
// decision, the classic /auth/login endpoint itself was never actually
// disabled.
const autoSsoDisabled = (): boolean => {
    try {
        return new URLSearchParams(window.location.search).get('auto_sso') === '0';
    } catch {
        return false;
    }
};

// Moves `node` to just before the "forgot password" link, so the SSO button
// ends up between the login button and that link instead of above the whole
// form (the only place Components.yml's Authentication.Container.BeforeContent
// slot can render into). Pterodactyl's login form uses twin.macro, which
// generates non-stable class names at runtime, so this matches on the
// link's text content instead - the one thing guaranteed not to be
// obfuscated. Retries via MutationObserver in case the form hasn't
// rendered yet when this component mounts.
const moveBeforeForgotPasswordLink = (node: HTMLElement): (() => void) => {
    const tryMove = (): boolean => {
        const candidates = Array.from(document.querySelectorAll('a, button'));
        const forgotLink = candidates.find((el) => /forgot password/i.test(el.textContent || ''));

        if (!forgotLink) {
            return false;
        }

        const target = forgotLink.closest('div') || forgotLink;
        if (!target.parentElement) {
            return false;
        }

        target.parentElement.insertBefore(node, target);
        return true;
    };

    if (tryMove()) {
        return () => undefined;
    }

    const observer = new MutationObserver(() => {
        if (tryMove()) {
            observer.disconnect();
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    return () => observer.disconnect();
};

export default () => {
    const [config, setConfig] = useState<SsoConfig | null>(null);
    const wrapperRef = useRef<HTMLDivElement>(null);
    const skipAutoRedirect = autoSsoDisabled();

    useEffect(() => {
        let cancelled = false;

        fetch('/extensions/{identifier}/config')
            .then((response) => response.json())
            .then((data: SsoConfig) => {
                if (!cancelled) {
                    setConfig(data);
                }
            })
            .catch(() => {
                // Fail silently - the classic username/password form still
                // works, we just don't offer the SSO option.
            });

        return () => {
            cancelled = true;
        };
    }, []);

    const shouldAutoRedirect = !!config?.enabled && config.hide_password_login && !skipAutoRedirect;

    useLayoutEffect(() => {
        if (!config?.enabled || shouldAutoRedirect || !wrapperRef.current) {
            return;
        }

        return moveBeforeForgotPasswordLink(wrapperRef.current);
    }, [config, shouldAutoRedirect]);

    if (!config || !config.enabled) {
        return null;
    }

    if (shouldAutoRedirect) {
        // Redirect immediately and cover the screen so the native login
        // form is never visible, without needing to touch/remove it.
        window.location.href = config.redirect_url;

        return (
            <div
                style={{
                    position: 'fixed',
                    inset: 0,
                    zIndex: 9999,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: '#0e0f16',
                    color: '#e0e2e9',
                    fontFamily: 'inherit',
                }}
            >
                <p>Redirecting to SSO login &hellip;</p>
            </div>
        );
    }

    return (
        <div ref={wrapperRef} style={{ width: '100%', margin: '1.5rem 0' }}>
            <div
                style={{
                    display: 'flex',
                    alignItems: 'center',
                    margin: '0 0 1rem',
                    color: '#8590a6',
                    fontSize: '0.75rem',
                    textTransform: 'uppercase',
                }}
            >
                <div style={{ flex: 1, height: 1, background: '#2c2e3b' }} />
                <span style={{ margin: '0 0.75rem' }}>or</span>
                <div style={{ flex: 1, height: 1, background: '#2c2e3b' }} />
            </div>
            <a
                href={config.redirect_url}
                style={{
                    display: 'block',
                    width: '100%',
                    boxSizing: 'border-box',
                    textAlign: 'center',
                    padding: '0.75rem 1rem',
                    borderRadius: '0.25rem',
                    background: '#0e4688',
                    color: '#fff',
                    textDecoration: 'none',
                    fontWeight: 600,
                }}
            >
                {config.button_text}
            </a>
        </div>
    );
};
