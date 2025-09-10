import { useEffect, useState, useRef } from "react";
import { getCalApi } from "@calcom/embed-react";
import { useFetcher } from "@remix-run/react";
import {
  Page,
  Layout,
  Text,
  Card,
  Button,
  BlockStack,
  TextField,
  FormLayout,
  Box,
  InlineStack,
  Select,
} from "@shopify/polaris";
import { TitleBar, useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { Resend } from "resend";
import { Client } from "@hubspot/api-client";

// Validation utility functions
function validateEmail(email) {
  // Stricter regex: valid email with only letters allowed after final dot
  const emailPattern = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
  return emailPattern.test(email);
}
const validateName = (name) =>
  /^[a-zA-Z\s'-]+$/.test(name || "") && name.trim().length >= 2;
const validatePhone = (phoneNumber, countryCode) => {
  if (!phoneNumber || phoneNumber.trim() === "") return true; // Optional field
  // Remove all non-digit characters for validation
  const cleanPhone = phoneNumber.replace(/[^\d]/g, "");
  // Should be between 7-12 digits (without country code)
  return cleanPhone.length >= 7 && cleanPhone.length <= 12;
};

// Country codes data
const COUNTRY_CODES = [
  { label: "🇺🇸 United States (+1)", value: "+1" },
  { label: "🇮🇳 India (+91)", value: "+91" },
  { label: "🇬🇧 United Kingdom (+44)", value: "+44" },
  { label: "🇨🇦 Canada (+1)", value: "+1" },
  { label: "🇦🇺 Australia (+61)", value: "+61" },
  { label: "🇩🇪 Germany (+49)", value: "+49" },
  { label: "🇫🇷 France (+33)", value: "+33" },
  { label: "🇯🇵 Japan (+81)", value: "+81" },
  { label: "🇨🇳 China (+86)", value: "+86" },
  { label: "🇧🇷 Brazil (+55)", value: "+55" },
  { label: "🇲🇽 Mexico (+52)", value: "+52" },
  { label: "🇷🇺 Russia (+7)", value: "+7" },
  { label: "🇰🇷 South Korea (+82)", value: "+82" },
  { label: "🇮🇹 Italy (+39)", value: "+39" },
  { label: "🇪🇸 Spain (+34)", value: "+34" },
  { label: "🇳🇱 Netherlands (+31)", value: "+31" },
  { label: "🇸🇪 Sweden (+46)", value: "+46" },
  { label: "🇳🇴 Norway (+47)", value: "+47" },
  { label: "🇩🇰 Denmark (+45)", value: "+45" },
  { label: "🇫🇮 Finland (+358)", value: "+358" },
];

export const loader = async ({ request }) => {
  await authenticate.admin(request);
  return null;
};

export const action = async ({ request }) => {
  await authenticate.admin(request);

  const formData = await request.formData();
  const firstName = formData.get("firstName");
  const lastName = formData.get("lastName");
  const email = formData.get("email");
  const countryCode = formData.get("countryCode");
  const phoneNumber = formData.get("phoneNumber");
  const phone = countryCode && phoneNumber ? `${countryCode} ${phoneNumber.trim()}` : null;
  const questions = formData.get("questions");

  // Server-side validation
  const errors = {};
  if (!firstName?.trim()) errors.firstName = "First name is required";
  else if (firstName.trim().length < 2) errors.firstName = "At least 2 characters";
  else if (firstName.trim().length > 50) errors.firstName = "Max 50 characters";
  else if (!validateName(firstName.trim())) errors.firstName = "Only letters, spaces, - and '";

  if (!lastName?.trim()) errors.lastName = "Last name is required";
  else if (lastName.trim().length < 2) errors.lastName = "At least 2 characters";
  else if (lastName.trim().length > 50) errors.lastName = "Max 50 characters";
  else if (!validateName(lastName.trim())) errors.lastName = "Only letters, spaces, - and '";

  if (!email?.trim()) errors.email = "Email is required";
  else if (email.trim().length > 254) errors.email = "Email too long";
  else if (!validateEmail(email.trim())) errors.email = "Invalid email";

  if (phoneNumber?.trim() && !validatePhone(phoneNumber.trim(), countryCode)) {
    errors.phoneNumber = "Invalid phone number format";
  }

  if (!questions?.trim()) errors.questions = "Questions field is required";
  else if (questions.trim().length < 10) errors.questions = "Minimum 10 characters";
  else if (questions.trim().length > 1000) errors.questions = "Max 1000 characters";

  if (Object.keys(errors).length > 0) {
    return { success: false, errors, message: "Please fix the validation errors" };
  }

  // Helper function for fallback to Prisma + Resend
  const fallbackToDatabase = async () => {
    console.log("Falling back to database and email notification");
    
    // Optional duplicate check
    const existing = await prisma.contactForm.findFirst({
      where: { email: email.trim().toLowerCase() },
    });
    if (existing) {
      return {
        success: false,
        message: "A submission with this email already exists. Please use a different email or contact support.",
      };
    }

    // Save to database
    await prisma.contactForm.create({
      data: {
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim().toLowerCase(),
        phone: phone?.trim() || null,
        questions: questions.trim(),
      },
    });

    // Send email notification
    const resend = new Resend(process.env.RESEND_API_KEY);
    await resend.emails.send({
      from: "onboarding@resend.dev",
      to: "abhinav.kavuluru@i95dev.com",
      subject: "New Contact Form Submission",
      html: `
        <h2>New Contact Form Submission</h2>
        <p><strong>First Name:</strong> ${firstName}</p>
        <p><strong>Last Name:</strong> ${lastName}</p>
        <p><strong>Email:</strong> ${email}</p>
        ${phone ? `<p><strong>Phone:</strong> ${phone}</p>` : ''}
        <p><strong>Questions:</strong></p>
        <p>${questions}</p>
      `,
    });

    return { success: true, message: "Form submitted successfully! Our team will contact you soon." };
  };

  try {
    // Try HubSpot first if API key is available
    if (process.env.HUBSPOT_API_KEY) {
      try {
        console.log("Attempting to create HubSpot contact");
        const hubspotClient = new Client({ accessToken: process.env.HUBSPOT_API_KEY });
        
        // Create contact in HubSpot
        const contactProperties = {
          firstname: firstName.trim(),
          lastname: lastName.trim(),
          email: email.trim().toLowerCase(),
          ...(phone && { phone: phone.trim() }),
          // Store questions in notes field or create a custom property in HubSpot
          hs_content_membership_notes: questions.trim()
        };

        await hubspotClient.crm.contacts.basicApi.create({
          properties: contactProperties
        });

        console.log("HubSpot contact created successfully");
        return { success: true, message: "Form submitted successfully! Our team will contact you soon." };
      } catch (hubspotError) {
        console.error("HubSpot creation failed, falling back to database:", hubspotError);
        // Fall back to database and email
        return await fallbackToDatabase();
      }
    } else {
      console.log("No HubSpot API key found, using database fallback");
      // No HubSpot API key, use database directly
      return await fallbackToDatabase();
    }
  } catch (error) {
    console.error("Form submission error:", error);
    return { success: false, message: "Failed to submit form. Please try again later." };
  }
};

export default function Index() {
  const fetcher = useFetcher();
  const shopify = useAppBridge();

  const isLoading =
    ["loading", "submitting"].includes(fetcher.state) && fetcher.formMethod === "POST";

  const [formData, setFormData] = useState({
    firstName: "",
    lastName: "",
    email: "",
    countryCode: "+1",
    phoneNumber: "",
    questions: "",
  });
  const [errors, setErrors] = useState({});
  const [touched, setTouched] = useState({});
  const [calReady, setCalReady] = useState(false);

  // Initialize Cal.com
  useEffect(() => {
    (async function () {
      try {
        const cal = await getCalApi({"namespace":"30min"});
        cal("ui", {"hideEventTypeDetails":false,"layout":"month_view"});
        setCalReady(true);
      } catch (error) {
        // console.error("Cal.com initialization failed:", error);
      }
    })();
  }, []);

  // Function to open Cal.com popup
  const openCalPopup = async () => {
    try {
      // console.log("Attempting to open Cal.com popup...");
      // Try to click the hidden button to trigger Cal.com popup
      const calButton = document.getElementById("cal-trigger-button");
      if (calButton) {
        calButton.click();
        // console.log("Cal.com popup triggered via button click");
      } else {
        // Fallback to API method
        const cal = await getCalApi({"namespace":"30min"});
        if (cal) {
          // console.log("Opening Cal.com popup via API...");
          cal("open", {
            calLink: "nsconnect/30min",
            namespace: "30min",
            config: {"layout":"month_view"}
          });
        } else {
          // console.error("Cal API not ready");
        }
      }
    } catch (error) {
      // console.error("Failed to open Cal.com popup:", error);
    }
  };

  // Handle result of submit
  useEffect(() => {
    if (fetcher.data?.success) {
      shopify.toast.show(fetcher.data.message, { duration: 1500 });

      // reset form
      setFormData({ firstName: "", lastName: "", email: "", countryCode: "+1", phoneNumber: "", questions: "" });
      setErrors({});
      setTouched({});
      
      // Open Cal.com popup after successful submission
      setTimeout(() => {
        if (calReady) {
          openCalPopup();
        } else {
          // console.log("Cal not ready, retrying...");
          setTimeout(() => openCalPopup(), 1000);
        }
      }, 1000);
    } else if (fetcher.data?.success === false) {
      if (fetcher.data.errors) setErrors(fetcher.data.errors);
      shopify.toast.show(fetcher.data.message, { isError: true });
    }
  }, [fetcher.data, shopify]);

  // Client-side validation
  const validateField = (field, value) => {
    let error = "";
    if (field === "firstName" || field === "lastName") {
      if (!value?.trim()) error = `${field === "firstName" ? "First" : "Last"} name is required`;
      else if (value.trim().length < 2) error = "At least 2 characters";
      else if (value.trim().length > 50) error = "Max 50 characters";
      else if (!validateName(value.trim())) error = "Only letters, spaces, - and '";
    } else if (field === "email") {
      if (!value?.trim()) error = "Email is required";
      else if (value.trim().length > 254) error = "Email too long";
      else if (!validateEmail(value.trim())) error = "Invalid email";
    } else if (field === "phoneNumber") {
      if (value?.trim() && !validatePhone(value.trim())) error = "Invalid phone number format";
    } else if (field === "countryCode") {
      // Country code doesn't need validation as it's from dropdown
    } else if (field === "questions") {
      if (!value?.trim()) error = "Questions field is required";
      else if (value.trim().length < 10) error = "Minimum 10 characters";
      else if (value.trim().length > 1000) error = "Max 1000 characters";
    }
    return error;
  };

  const handleSubmit = () => {
    // Validate before submission
    const newErrors = {};
    Object.keys(formData).forEach((field) => {
      const error = validateField(field, formData[field]);
      if (error) newErrors[field] = error;
    });
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      setTouched(Object.keys(formData).reduce((acc, k) => ({ ...acc, [k]: true }), {}));
      shopify.toast.show("Please fix the validation errors", { isError: true });
      return;
    }

    const form = new FormData();
    Object.entries(formData).forEach(([k, v]) => form.append(k, v));
    fetcher.submit(form, { method: "POST" });
  };

  const handleInputChange = (field) => (value) => {
    setFormData((prev) => ({ ...prev, [field]: value }));
    if (touched[field]) {
      const error = validateField(field, value);
      setErrors((prev) => ({ ...prev, [field]: error }));
    }
  };
  const handleBlur = (field) => () => {
    setTouched((prev) => ({ ...prev, [field]: true }));
    const error = validateField(field, formData[field]);
    setErrors((prev) => ({ ...prev, [field]: error }));
  };

  return (
    <Page>
      <TitleBar title="NetSuite Integration" />
      <Layout>
        <Layout.Section>
          {/* Header Image */}
          <Box paddingBlockEnd="10">
            <div
              style={{
                width: "100%",
                height: "210px",
                backgroundImage: "url(/V1.png)",
                backgroundSize: "cover",
                backgroundPosition: "center",
                backgroundRepeat: "no-repeat",
                borderRadius: "12px",
              }}
            />
          </Box>

          <Card>
            <BlockStack gap="600">
              <Box paddingInline="400" paddingBlock="400">
                <BlockStack gap="300">
                  <InlineStack align="center">
                    <Text as="h1" variant="headingXl" alignment="center">
                      Shopify NetSuite Integration
                    </Text>
                  </InlineStack>
                  <InlineStack align="center">
                    <Text variant="bodyLg" as="p" tone="subdued" alignment="center">
                      Fill out this form and our team will reach out to onboard you
                    </Text>
                  </InlineStack>
                </BlockStack>
              </Box>

              <Box paddingInline="400" paddingBlockEnd="400">
                <FormLayout>
                  <FormLayout.Group>
                    <TextField
                      label="First Name"
                      value={formData.firstName}
                      onChange={handleInputChange("firstName")}
                      onBlur={handleBlur("firstName")}
                      autoComplete="given-name"
                      required
                      error={errors.firstName}
                      maxLength={50}
                    />
                    <TextField
                      label="Last Name"
                      value={formData.lastName}
                      onChange={handleInputChange("lastName")}
                      onBlur={handleBlur("lastName")}
                      autoComplete="family-name"
                      required
                      error={errors.lastName}
                      maxLength={50}
                    />
                  </FormLayout.Group>

                  <TextField
                    label="Email"
                    type="email"
                    value={formData.email}
                    onChange={handleInputChange("email")}
                    onBlur={handleBlur("email")}
                    autoComplete="email"
                    required
                    error={errors.email}
                    maxLength={254}
                  />

                  <FormLayout.Group>
                    <Select
                      label="Country Code (Optional)"
                      options={COUNTRY_CODES}
                      value={formData.countryCode}
                      onChange={handleInputChange("countryCode")}
                    />
                    <TextField
                      label="Phone Number (Optional)"
                      type="tel"
                      value={formData.phoneNumber}
                      onChange={handleInputChange("phoneNumber")}
                      onBlur={handleBlur("phoneNumber")}
                      autoComplete="tel"
                      placeholder="555-123-4567"
                      helpText="Enter your phone number without country code"
                      error={errors.phoneNumber}
                      maxLength={15}
                    />
                  </FormLayout.Group>

                  <TextField
                    label="Questions, Needs, or Challenges"
                    value={formData.questions}
                    onChange={handleInputChange("questions")}
                    onBlur={handleBlur("questions")}
                    multiline={4}
                    helpText={
                      <span>
                        By supplying my contact information, I authorize i95Dev to contact me
                        regarding its products and services. See our{" "}
                        <a
                          href="https://www.i95dev.com/privacy-policy/"
                          target="_blank"
                          rel="noopener noreferrer"
                          style={{ color: "#005bd3", textDecoration: "underline" }}
                        >
                          Privacy Policy
                        </a>{" "}
                        for more details.
                      </span>
                    }
                    required
                    error={errors.questions}
                    maxLength={1000}
                  />

                  <Box paddingBlockStart="400">
                    <InlineStack align="center">
                      <Button
                        primary
                        loading={isLoading}
                        onClick={handleSubmit}
                        size="large"
                        disabled={isLoading}
                      >
                        {isLoading ? "Submitting..." : "Submit"}
                      </Button>
                    </InlineStack>
                  </Box>

                  {/* Hidden Cal.com trigger button */}
                  <button
                    style={{ display: "none" }}
                    data-cal-namespace="30min"
                    data-cal-link="nsconnect/30min"
                    data-cal-config='{"layout":"month_view"}'
                    id="cal-trigger-button"
                  >
                    Schedule Meeting
                  </button>
                </FormLayout>
              </Box>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}