// Spike S-1: a headless Sparkle 2 updater — no UI, every question answered "install and relaunch".
#import "SparkleBridge.h"
#import <AppKit/AppKit.h>
#import <Sparkle/Sparkle.h>
#include <unistd.h>

static NSString *gLog;
static NSString *gVersion;

static void lfcpLog(NSString *step, id _Nullable detail) {
  NSDictionary *o = @{
    @"event" : @"sparkle",
    @"step" : step,
    @"detail" : detail ?: [NSNull null],
    @"pid" : @(getpid()),
    @"version" : gVersion ?: @"?",
    @"time" : [[NSISO8601DateFormatter new] stringFromDate:[NSDate date]],
  };
  NSData *d = [NSJSONSerialization dataWithJSONObject:o options:NSJSONWritingSortedKeys error:nil];
  if (d == nil) return;
  NSMutableData *line = [d mutableCopy];
  [line appendBytes:"\n" length:1];
  fwrite(line.bytes, 1, line.length, stdout);
  fflush(stdout);
  if (gLog == nil) return;
  NSFileHandle *h = [NSFileHandle fileHandleForWritingAtPath:gLog];
  if (h == nil) {
    [line writeToFile:gLog atomically:NO];
    return;
  }
  [h seekToEndOfFile];
  [h writeData:line];
  [h closeFile];
}

static NSString *describe(NSError *e) {
  return [NSString stringWithFormat:@"%@ %ld: %@ %@", e.domain, (long)e.code, e.localizedDescription,
                                    e.userInfo[NSUnderlyingErrorKey] ?: @""];
}

@interface LFCPAutoDriver : NSObject <SPUUserDriver>
@end

@implementation LFCPAutoDriver
- (void)showUpdatePermissionRequest:(SPUUpdatePermissionRequest *)request
                              reply:(void (^)(SUUpdatePermissionResponse *))reply {
  lfcpLog(@"permissionRequest", nil);
  reply([[SUUpdatePermissionResponse alloc] initWithAutomaticUpdateChecks:NO sendSystemProfile:NO]);
}
- (void)showUserInitiatedUpdateCheckWithCancellation:(void (^)(void))cancellation {
  lfcpLog(@"checking", nil);
}
- (void)showUpdateFoundWithAppcastItem:(SUAppcastItem *)appcastItem
                                 state:(SPUUserUpdateState *)state
                                 reply:(void (^)(SPUUserUpdateChoice))reply {
  lfcpLog(@"updateFound", @{@"version" : appcastItem.versionString, @"stage" : @(state.stage)});
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showUpdateReleaseNotesWithDownloadData:(SPUDownloadData *)downloadData {
}
- (void)showUpdateReleaseNotesFailedToDownloadWithError:(NSError *)error {
}
- (void)showUpdateNotFoundWithError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  lfcpLog(@"updateNotFound", describe(error));
  acknowledgement();
  exit(6);
}
- (void)showUpdaterError:(NSError *)error acknowledgement:(void (^)(void))acknowledgement {
  lfcpLog(@"updaterError", describe(error));
  acknowledgement();
  exit(7);
}
- (void)showDownloadInitiatedWithCancellation:(void (^)(void))cancellation {
  lfcpLog(@"downloadStarted", nil);
}
- (void)showDownloadDidReceiveExpectedContentLength:(uint64_t)expectedContentLength {
  lfcpLog(@"downloadLength", @(expectedContentLength));
}
- (void)showDownloadDidReceiveDataOfLength:(uint64_t)length {
}
- (void)showDownloadDidStartExtractingUpdate {
  lfcpLog(@"extracting", nil);
}
- (void)showExtractionReceivedProgress:(double)progress {
}
- (void)showReadyToInstallAndRelaunch:(void (^)(SPUUserUpdateChoice))reply {
  lfcpLog(@"readyToInstall", nil);
  reply(SPUUserUpdateChoiceInstall);
}
- (void)showInstallingUpdateWithApplicationTerminated:(BOOL)applicationTerminated
                          retryTerminatingApplication:(void (^)(void))retryTerminatingApplication {
  lfcpLog(@"installing", @{@"applicationTerminated" : @(applicationTerminated)});
  // Sparkle normally terminates the app itself; if it has not, leave so the installer can proceed.
  if (!applicationTerminated) {
    dispatch_after(dispatch_time(DISPATCH_TIME_NOW, 3 * NSEC_PER_SEC), dispatch_get_main_queue(), ^{
      lfcpLog(@"terminating", nil);
      [NSApp terminate:nil];
    });
  }
}
- (void)showUpdateInstalledAndRelaunched:(BOOL)relaunched acknowledgement:(void (^)(void))acknowledgement {
  lfcpLog(@"installedAndRelaunched", @(relaunched));
  acknowledgement();
}
- (void)showUpdateInFocus {
}
- (void)dismissUpdateInstallation {
  lfcpLog(@"dismissed", nil);
}
@end

@interface LFCPUpdaterDelegate : NSObject <SPUUpdaterDelegate>
@end

@implementation LFCPUpdaterDelegate
- (void)updater:(SPUUpdater *)updater didFindValidUpdate:(SUAppcastItem *)item {
  lfcpLog(@"validUpdate", item.versionString);
}
- (void)updater:(SPUUpdater *)updater willInstallUpdate:(SUAppcastItem *)item {
  lfcpLog(@"willInstall", item.versionString);
}
- (void)updaterWillRelaunchApplication:(SPUUpdater *)updater {
  lfcpLog(@"willRelaunch", nil);
}
- (void)updater:(SPUUpdater *)updater didAbortWithError:(NSError *)error {
  lfcpLog(@"aborted", describe(error));
}
- (void)updater:(SPUUpdater *)updater failedToDownloadUpdate:(SUAppcastItem *)item error:(NSError *)error {
  lfcpLog(@"downloadFailed", describe(error));
}
@end

static SPUUpdater *gUpdater;
static LFCPAutoDriver *gDriver;
static LFCPUpdaterDelegate *gDelegate;

NSString *LFCPStartUpdate(NSString *logPath, NSString *version) {
  gLog = [logPath copy];
  gVersion = [version copy];
  gDriver = [LFCPAutoDriver new];
  gDelegate = [LFCPUpdaterDelegate new];
  NSBundle *main = [NSBundle mainBundle];
  gUpdater = [[SPUUpdater alloc] initWithHostBundle:main applicationBundle:main userDriver:gDriver delegate:gDelegate];
  NSError *error = nil;
  if (![gUpdater startUpdater:&error]) return error ? describe(error) : @"startUpdater failed";
  lfcpLog(@"started", gUpdater.feedURL.absoluteString);
  [gUpdater checkForUpdates];
  return nil;
}
