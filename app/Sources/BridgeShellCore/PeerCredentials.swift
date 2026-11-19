// `LFCP Bridge --peer-uid` (A§7.3, PLAN §E-006): the host's support.sock serves only its own user,
// and Node cannot read a unix-socket peer's credentials. The host passes an accepted connection as
// this process's fd 3; it prints getpeereid's uid and exits (no window server, no app).

import Foundation

public enum PeerCredentials {
  /** The fd the host passes the connection on. */
  public static let connectionFD: Int32 = 3

  /** The effective uid of the peer of a connected unix socket; nil when it cannot be told. */
  public static func uid(of fd: Int32) -> uid_t? {
    var uid: uid_t = 0
    var gid: gid_t = 0
    return getpeereid(fd, &uid, &gid) == 0 ? uid : nil
  }

  /** The subcommand: the uid on stdout, exit 0; nothing and exit 1 when it cannot be told. */
  public static func main() -> Int32 {
    guard let uid = uid(of: connectionFD) else { return 1 }
    print(uid)
    return 0
  }
}
