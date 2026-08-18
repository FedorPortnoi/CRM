package expo.modules.rustoreinstallreferrer

import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import ru.rustore.sdk.install.referrer.InstallReferrerClient
import ru.rustore.sdk.install.referrer.model.InstallReferrerV2

/**
 * Small Expo bridge around RuStore's Android-only Install Referrer SDK.
 *
 * The V2 API is intentionally used here: it is RuStore's currently documented
 * referrer contract and is present in the latest artifact published in the
 * official Maven repository.
 */
class RuStoreInstallReferrerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("RuStoreInstallReferrer")

    AsyncFunction("getInstallReferrer") { promise: Promise ->
      val context = appContext.reactContext
      if (context == null) {
        promise.reject(Exceptions.ReactContextLost())
        return@AsyncFunction
      }

      InstallReferrerClient(context)
        .getInstallReferrerV2()
        .addOnSuccessListener { result: InstallReferrerV2? ->
          promise.resolve(result?.installReferrer?.trim()?.takeIf { it.isNotEmpty() })
        }
        .addOnFailureListener { throwable ->
          promise.reject(
            "ERR_RUSTORE_INSTALL_REFERRER",
            throwable.message ?: "RuStore install referrer lookup failed",
            throwable,
          )
        }
    }
  }
}
