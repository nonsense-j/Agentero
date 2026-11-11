import { useTranslation } from "react-i18next";
import {
	SettingsGroup,
	SettingsRow,
	SettingsSectionLabel,
} from "@/components/settings/settings-layout";
import { Button } from "@/components/ui/button";
import { clearUsage } from "@/lib/activity";
import { errorText } from "@/lib/core/error";
import { notifyError, notifySuccess } from "@/lib/core/notify";

export function PrivacySettingsBlock() {
	const { t } = useTranslation("settings");
	return (
		<>
			<SettingsSectionLabel className="mt-4">
				{t("general.privacy.section")}
			</SettingsSectionLabel>
			<SettingsGroup>
				<SettingsRow label={t("general.privacy.clearUsage.label")}>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => {
							void clearUsage()
								.then(() => notifySuccess(t("general.privacy.clearUsage.done")))
								.catch((e) => notifyError(errorText(e)));
						}}
					>
						{t("general.privacy.clearUsage.action")}
					</Button>
				</SettingsRow>
			</SettingsGroup>
		</>
	);
}
