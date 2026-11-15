#[cfg(target_os = "linux")]
pub fn install(window: &tauri::WebviewWindow, origin: String) -> tauri::Result<()> {
    use webkit2gtk::{glib::prelude::*, PermissionRequestExt, WebViewExt};

    window.with_webview(move |platform| {
        platform
            .inner()
            .connect_permission_request(move |view, request| {
                if !request.is::<webkit2gtk::UserMediaPermissionRequest>() {
                    return false;
                }
                // WebKitGTK's capture request does not expose the requesting frame's origin.
                let own_origin = view.uri().is_some_and(|uri| {
                    tauri::Url::parse(&uri)
                        .is_ok_and(|url| url.origin().ascii_serialization() == origin)
                });
                if own_origin {
                    request.allow();
                } else {
                    request.deny();
                }
                true
            });
    })
}

#[cfg(windows)]
pub fn install(window: &tauri::WebviewWindow, origin: String) -> tauri::Result<()> {
    use webview2_com::{Microsoft::Web::WebView2::Win32::*, PermissionRequestedEventHandler};
    use windows::core::PWSTR;

    window.with_webview(move |platform| {
        // SAFETY: Tauri executes this closure on the WebView2 UI thread.
        let result = unsafe {
            platform.controller().CoreWebView2().and_then(|view| {
                let mut token = 0;
                view.add_PermissionRequested(
                    &PermissionRequestedEventHandler::create(Box::new(move |_, args| {
                        let Some(args) = args else { return Ok(()) };
                        let mut kind = COREWEBVIEW2_PERMISSION_KIND::default();
                        args.PermissionKind(&mut kind)?;
                        if kind != COREWEBVIEW2_PERMISSION_KIND_MICROPHONE
                            && kind != COREWEBVIEW2_PERMISSION_KIND_CAMERA
                        {
                            return Ok(());
                        }
                        let mut uri = PWSTR::null();
                        args.Uri(&mut uri)?;
                        let uri = webview2_com::take_pwstr(uri);
                        let own_origin = tauri::Url::parse(&uri)
                            .is_ok_and(|url| url.origin().ascii_serialization() == origin);
                        args.SetState(if own_origin {
                            COREWEBVIEW2_PERMISSION_STATE_ALLOW
                        } else {
                            COREWEBVIEW2_PERMISSION_STATE_DENY
                        })?;
                        Ok(())
                    })),
                    &mut token,
                )
            })
        };
        if let Err(error) = result {
            eprintln!("could not install media permission handler: {error}");
        }
    })
}

#[cfg(target_os = "macos")]
mod macos {
    use block2::Block;
    use objc2::{
        msg_send,
        runtime::{AnyClass, AnyObject, ClassBuilder, Sel},
        sel,
    };
    use objc2_web_kit::{WKMediaCaptureType, WKPermissionDecision, WKSecurityOrigin};
    use std::sync::{OnceLock, RwLock};

    static ORIGIN: RwLock<Option<String>> = RwLock::new(None);
    static DELEGATE_CLASS: OnceLock<&'static AnyClass> = OnceLock::new();

    extern "C-unwind" fn capture_permission(
        _: &AnyObject,
        _: Sel,
        _: &AnyObject,
        origin: &WKSecurityOrigin,
        _: &AnyObject,
        _: WKMediaCaptureType,
        decision: &Block<dyn Fn(WKPermissionDecision)>,
    ) {
        // SAFETY: WebKit supplies a live WKSecurityOrigin on its UI thread.
        let requested = unsafe {
            format!(
                "{}://{}:{}",
                origin.protocol(),
                origin.host(),
                origin.port()
            )
        };
        let own_origin = tauri::Url::parse(&requested).is_ok_and(|url| {
            ORIGIN.read().is_ok_and(|allowed| {
                allowed
                    .as_ref()
                    .is_some_and(|allowed| url.origin().ascii_serialization() == *allowed)
            })
        });
        decision.call((if own_origin {
            WKPermissionDecision::Grant
        } else {
            WKPermissionDecision::Deny
        },));
    }

    pub fn install(window: &tauri::WebviewWindow, origin: String) -> tauri::Result<()> {
        if let Ok(mut allowed) = ORIGIN.write() {
            *allowed = Some(origin);
        }
        window.with_webview(move |platform| {
            // SAFETY: Tauri supplies a live WKWebView on the UI thread.
            let delegate: &AnyObject = unsafe {
                msg_send![platform.inner().cast::<AnyObject>(), UIDelegate]
            };
            let subclass = DELEGATE_CLASS.get_or_init(|| {
                let mut builder = ClassBuilder::new(c"TarcswebMediaUIDelegate", delegate.class())
                    .expect("media delegate class is registered once");
                // SAFETY: The signature matches WKUIDelegate's capture callback.
                unsafe {
                    builder.add_method(
                        sel!(webView:requestMediaCapturePermissionForOrigin:initiatedByFrame:type:decisionHandler:),
                        capture_permission as extern "C-unwind" fn(_, _, _, _, _, _, _),
                    );
                }
                builder.register()
            });
            if delegate.class() != *subclass {
                // SAFETY: The subclass adds no ivars and preserves Wry's remaining delegate methods.
                unsafe { AnyObject::set_class(delegate, subclass); }
            }
        })
    }
}

#[cfg(target_os = "macos")]
pub use macos::install;
