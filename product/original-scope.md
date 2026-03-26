# **Monthly CEO Journal Summary**

- Zoom links \- 

## **1\. Overview**

 **Primary users:**

* CEOs enrolled in our 1:1 10x coaching program  
* The executive coaches delivering the coaching 1:1 sessions  
* EP internal admin team members

**Overview:**  
The AI summary tool (will call it ‘Journal’ from here on out for simplicity) generates a **monthly, coach-reviewed progress summary** for each CEO in the coaching program. 

The summary synthesizes multiple qualitative inputs (reflections, 1:1 session notes, transcripts, and 10x curriculum) to assess progress toward the CEO’s stated 10x goal, surface key wins and challenges for the month, and propose aligned next steps and resources based on the program’s framework as well as CEO activity over time.

The Journal is **not** a replacement for the 1:1 coaching. It is a structured reflection and synthesis tool to:

* Improve continuity across sessions  
* Reduce coach admin time  
* Create a record of CEO progress

---

## **2\. Inputs**

The Journal must ingest the following inputs per CEO:

### **2.1 CEO Inputs**

1. **Weekly reflections for the month (plus any from prior months as a reference)**

   * Note: They are asked to fill this out weekly, but it’s possible that they don’t fill it out for one or more weeks and we may be missing some inputs here in a given month.  
   * Primarily short-form written reflections (free text)  
   * Some quantitative questions planned (e.g. numerical scale)  
2. **Monthly reflection**

   * Longer, end-of-month qualitative reflection inputs (free text)  
   * KPI/metric updates

3. **10x goal**  
   * Statement of the CEO’s overarching goal, set at the beginning of the program and stated on their documents

4. **Monthly goal(s)**  
   * CEO will agree on a set of monthly goals with their coach each month. These should also be recorded in the weekly reflection docs.

### **2.2 Coach-Provided or System Inputs**

4. **1:1 coaching session follow-up notes \[phase 1: manual\]**  
   * Structured or semi-structured notes (probably in email)  
   * Action items \+ summary

5. **1:1 coaching session transcript**  
   * Full transcript or summarized transcript

6. **Program curriculum & framework**  
   * Static reference materials (pillars, principles, action frameworks, terminology, books)  
   * Includes 12 videos of our teaching sessions from our CEO Accelerator program, documents describing the 10x framework  
   * Can also provide the materials we used to build our Delphi clone (e.g. LI posts, YT transcripts) if we need to refine further  
   * Should be used as authoritative guidance for recommendations

---

## **3\. Core Outputs**

### **3.1 Monthly CEO Summary (Primary Artifact)**

Generated once per month per CEO. Stored in the database alongside CEO data.

**Sections:**

1. **Progress Summary**  
   * Synthesis of activity and movement toward the 10x goal  
   * Activity and movement toward monthly goals  
   * Challenges and where progress has not yet been made toward the goals  
   * Emphasis on concrete changes, decisions, or behaviors

2. **Key Wins**  
   * Clear, outcome-oriented highlights (can be drawn from progress reported in the weekly journals)

3. **Challenges & Constraints**  
   * Framed neutrally and constructively

4. **Pattern Observations**  
   * Repeated behaviors, bottlenecks, or mindset themes across the month and across prior months as the dataset builds up during the program

5. **Suggested Next Steps**  
   * Explicitly aligned with the coaching program’s framework  
   * Actionable and prioritized  
   * Statement that they should discuss these at their monthly coaching session

6. **Suggested Resources Related to Suggested Next Steps**  
   * Curriculum modules, exercises, or internal resources from our library

**Signature:**

* Phase 1:  
  * Output can be pulled from the tool and provided to the coach, who can edit it manually.  
  * Open question: how to use the edited versions to provide input to upgrade the prompt over time  
  * Phase 2: edited version is stored in the database for the given CEO

---

## **4\. Coach Review & Editing Workflow**

### **4.1 Coach and EP Admin Team Capabilities**

* View AI-generated monthly summary drafts \- we can pull from the database  
* Edit any section of the summary  
* Approve the final version  
* Send through Email

### **4.2 CEO Capabilities**

* View only **approved** summaries  
* Cannot see AI drafts or any coach internal notes  
* Read-only access to the monthly summaries  
* Access to all monthly summaries (including from prior months)  
  * Let’s discuss \- it could be that we’re generating a PDF for them and thus we need a storage solution, rather than the tool itself dealing with this

### **4.3 Versioning (lower priority)**

* System should ideally retain for learning/training purposes:  
  * AI-generated draft  
  * Coach-edited final version

* Admin must be able to audit changes if needed

---

## **5\. Roles & Access Control**

### **5.1 User Roles**

**CEO**

* Access only their own data and summaries

**Coach**

* Access only the information related to assigned coachees  
* Cannot view other coaches’ clients

**Admin (EP Team) \- Depending on Nadia \- we can create a simple way to pull data from the database, as long as the report has been stored**

* Global and edit access to:

  * All clients  
  * All summaries  
  * All coaches  
  * Aggregated views over time

### **5.2 Tool Authentication & Authorization**

* **Ideally the same tool can handle call scheduling, hosting, and notes so that all 1:1 session data is in the same place to collect for the summaries \- let’s discuss**

* Individual logins for each coach  
* If being used for calls, individual logins for coachees  
* Role-based access control (RBAC)  
* Admin access to all activity/data on the platform

---

## **6\. Phase 2: Admin & Oversight Requirements**

Admin users must be able to:

* View **monthly summary data across all clients**  
* Filter by:  
  * Coach  
  * Client  
  * Time period

* See longitudinal progress per client (month-over-month summaries)  
* Access call overviews / notes for all coaches  
* Export data for internal analysis (subject to privacy rules)

---

## **7\. AI / Model Requirements**

### **7.1 Model Constraints**

* Model must be **closed and system-internal**  
* Data **must not** be used to train a public or shared foundation model  
* No third-party training or retention outside the organization

### **7.2 Training & Fine-Tuning**

* If any internal fine-tuning is performed to improve the prompt:  
  * Data must be **fully anonymized**  
  * No personally identifiable information (PII)  
  * No company-identifiable information

### **7.3 Prompting & Guardrails**

* Outputs must:  
  * Stay within the coaching framework  
  * Avoid diagnostic or therapeutic language  
  * Avoid legal, medical, or mental health claims  
* Tone: professional, reflective, and coach-aligned

---

## **8\. Data Storage & Compliance**

### **8.1 Compliance Requirements**

* Must comply with:

  * GDPR (EU)  
  * US data protection standards

* Explicit support for:  
  * Data access requests  
  * Data deletion requests  
  * Data export (per user)

### **8.2 Data Residency**

* Storage solution must support EU and Phase 2: US compliance  
* Clear documentation of where data is stored

### **8.3 Data Ownership**

* The tool is proprietary and can be used only by EP organization  
* All data stored under **EP-owned accounts \-** we will set up an account on the tool(s) we need that you can use  
* EP Team must be able to:  
  * Revoke access to other accounts  
  * Retain full control post-engagement

---

## **9\. Security Requirements**

* Encrypted data at rest and in transit  
* Audit logs preferred for:  
  * Summary edits  
  * Approvals  
* Secure handling of transcripts and notes

---

## **10\. Non-Functional Requirements**

* Clear separation between:

  * Stored draft state  
  * Stored approved state (if we’re able to feed back in the edited version)  
* Performance:

  * Monthly generation can be async  
  * No real-time constraints

* Scalability: Phase 2

  * Supports growth in number of coaches and clients without becoming prohibitively expensive  
  * Goal to expand to 3000 clients within 2 years  
  * Plan to build custom platform/UI for hosting CEO experience, content, weekly reflections. We’d be passing data between the Journal model and the platform.

---

## **11\. Open Technical Decisions (for Martin):**

Please propose solutions for:

* AI model approach (within constraints above)  
  * Foundational Model API options offer the data privacy we need  
  * Region pinning  
* Proposed tool(s) that we’d need to bring everything together and their costs  
  * Vercel ($50/month)  
  * Neon($100/month) \- Big query compatible?  
  * LLMs (Variable but will be within reason/cheap \- ball park $100/month)  
  * Clerk (25$/mont  
  * [Fireflies.ai](http://Fireflies.ai) \- ($19/month/coach)  
  * AWS \- File storage \- negligible  
  * Total \- $275/month \+ $19/month/coach  
    * The infrastructure cost will remain stable/not go up for 3000 CEOs  
    * LLM costs will go up linearly with users \+ new features  
* Data storage architecture  
  * Two instances both EU, US  
    * Db  
    * File storage (if necessary)  
* Authentication  
  * Clerk  
* Admin and coach view implementation  
  * Next.js / React / TS frontend / TS backend  
* Deployment and handover plan  
  * Github \+ CI/CD \+ Vercel \+ Documentation  
  * Also handbook for coaches on how to onboard to third party tools

