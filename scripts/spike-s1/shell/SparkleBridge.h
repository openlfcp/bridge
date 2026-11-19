// Spike S-1: the Sparkle side of the shell, in Objective-C so that the SPUUserDriver selectors are
// exactly those of Sparkle's headers. main.swift sees only this C function (-import-objc-header).
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN
/// Starts an SPUUpdater with a user driver that accepts everything (install and relaunch), then
/// checks the feed. Progress is appended to `logPath` as JSON lines. nil, or why it could not start.
NSString *_Nullable LFCPStartUpdate(NSString *logPath, NSString *version);
NS_ASSUME_NONNULL_END
