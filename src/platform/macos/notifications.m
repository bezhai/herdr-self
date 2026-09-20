#import <AppKit/AppKit.h>
#import <UserNotifications/UserNotifications.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

// Only private, regular request files from this user can launch a callback.
static NSDictionary *ReadRequest(NSString *path) {
    int fd = open(path.fileSystemRepresentation, O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    if (fd < 0) return nil;
    struct stat info;
    if (fstat(fd, &info) != 0 || !S_ISREG(info.st_mode) || info.st_uid != geteuid()
        || (info.st_mode & 0077) != 0 || info.st_size <= 0 || info.st_size > 65536) {
        close(fd); return nil;
    }
    NSMutableData *bytes = [NSMutableData dataWithLength:(NSUInteger)info.st_size];
    NSUInteger offset = 0;
    while (offset < bytes.length) {
        ssize_t count = read(fd, (char *)bytes.mutableBytes + offset, bytes.length - offset);
        if (count <= 0) { close(fd); return nil; }
        offset += (NSUInteger)count;
    }
    close(fd);
    id value = [NSJSONSerialization JSONObjectWithData:bytes options:0 error:nil];
    if (![value isKindOfClass:NSDictionary.class]) return nil;
    unlink(path.fileSystemRepresentation);
    return value;
}

@interface HerdrNotifications : NSObject <NSApplicationDelegate, UNUserNotificationCenterDelegate>
@end
@implementation HerdrNotifications
- (void)applicationWillFinishLaunching:(NSNotification *)notification {
    (void)notification;
    UNUserNotificationCenter.currentNotificationCenter.delegate = self;
}
- (void)application:(NSApplication *)application openFiles:(NSArray<NSString *> *)filenames {
    for (NSString *filename in filenames) {
        NSDictionary *request = ReadRequest(filename);
        if (![request[@"title"] isKindOfClass:NSString.class] || ![request[@"body"] isKindOfClass:NSString.class]) continue;
        UNUserNotificationCenter *center = UNUserNotificationCenter.currentNotificationCenter;
        [center requestAuthorizationWithOptions:UNAuthorizationOptionAlert completionHandler:^(BOOL granted, NSError *error) {
            if (!granted || error) { NSLog(@"Herdr notification permission unavailable: %@", error); return; }
            UNMutableNotificationContent *content = [UNMutableNotificationContent new];
            content.title = request[@"title"];
            content.body = request[@"body"];
            // User info survives helper termination and a Notification Center cold launch.
            content.userInfo = request;
            UNNotificationRequest *notification = [UNNotificationRequest requestWithIdentifier:NSUUID.UUID.UUIDString content:content trigger:nil];
            [center addNotificationRequest:notification withCompletionHandler:^(NSError *failure) {
                if (failure) NSLog(@"Herdr notification scheduling failed: %@", failure);
            }];
        }];
    }
    [application replyToOpenOrPrint:NSApplicationDelegateReplySuccess];
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
      willPresentNotification:(UNNotification *)notification
        withCompletionHandler:(void (^)(UNNotificationPresentationOptions))completionHandler {
    (void)center; (void)notification;
    completionHandler(UNNotificationPresentationOptionAlert);
}
- (void)userNotificationCenter:(UNUserNotificationCenter *)center
 didReceiveNotificationResponse:(UNNotificationResponse *)response
        withCompletionHandler:(void (^)(void))completionHandler {
    (void)center;
    if (![response.actionIdentifier isEqualToString:UNNotificationDefaultActionIdentifier]) { completionHandler(); return; }
    NSDictionary *info = response.notification.request.content.userInfo;
    NSString *executable = info[@"executable"];
    NSString *socket = info[@"socket"];
    NSString *activation = info[@"activation"];
    if ([executable isKindOfClass:NSString.class] && executable.isAbsolutePath
        && [socket isKindOfClass:NSString.class] && socket.isAbsolutePath
        && [activation isKindOfClass:NSString.class]) {
        NSTask *task = [NSTask new];
        task.executableURL = [NSURL fileURLWithPath:executable];
        task.arguments = @[@"--notification-callback", socket, activation];
        task.standardInput = NSFileHandle.fileHandleWithNullDevice;
        task.standardOutput = NSFileHandle.fileHandleWithNullDevice;
        task.terminationHandler = ^(NSTask *finished) {
            if (finished.terminationStatus != 0) NSLog(@"Herdr originating client unavailable (callback exit %d)", finished.terminationStatus);
        };
        NSError *error = nil;
        if (![task launchAndReturnError:&error]) NSLog(@"Herdr originating client callback failed: %@", error);
    }
    NSString *bundle = info[@"terminal_bundle"];
    if ([bundle isKindOfClass:NSString.class] && bundle.length > 0) {
        dispatch_async(dispatch_get_main_queue(), ^{
            NSArray<NSRunningApplication *> *applications = [NSRunningApplication runningApplicationsWithBundleIdentifier:bundle];
            // Only raise an existing host terminal; never launch an invisible replacement TUI.
            [applications.firstObject activateWithOptions:NSApplicationActivateIgnoringOtherApps];
        });
    }
    completionHandler();
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *application = NSApplication.sharedApplication;
        // NSApplication does not retain its delegate. Keep it alive across the run loop.
        static HerdrNotifications *delegate;
        delegate = [HerdrNotifications new];
        application.delegate = delegate;
        [application setActivationPolicy:NSApplicationActivationPolicyAccessory];
        [application run];
    }
    return 0;
}
