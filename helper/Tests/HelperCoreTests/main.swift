import Foundation
#if SWIFT_PACKAGE
import HelperCore
#endif

registerProtocolTests()
registerWriteTests()
registerEventTests()
registerRetryTests()
registerGateTests()
registerRetryRecheckTests()
exit(runAllTests())
