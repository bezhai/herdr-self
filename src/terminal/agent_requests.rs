//! Permission requests and questions an agent is waiting on.
//!
//! An integration hook reports each request and keeps its API connection open
//! until someone answers or the request ends. Requests are shared runtime facts
//! kept in memory only; they are not persisted in session snapshots and do not
//! survive a server restart or live handoff.

use std::collections::BTreeSet;

use crate::api::schema::{AgentRequestAnswer, AgentRequestContent, AgentRequestKind};

use super::truncate_to_char_boundary;

/// Largest stored input preview in UTF-8 bytes.
pub const MAX_AGENT_REQUEST_PREVIEW_BYTES: usize = 8 * 1024;
/// Most questions one question request may ask.
pub const MAX_AGENT_REQUEST_QUESTIONS: usize = 4;

/// A request reported for a pane by an agent integration hook.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequestReport {
    pub source: String,
    pub agent_label: String,
    pub agent_session_id: Option<String>,
    pub content: AgentRequestContent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AgentRequest {
    pub id: u64,
    pub content: AgentRequestContent,
}

/// Checks the shape of reported request content and normalizes it: the input
/// preview is cut to its size limit and repeated decisions are dropped.
pub fn validate_agent_request(
    mut content: AgentRequestContent,
) -> Result<AgentRequestContent, String> {
    if content.tool_name.trim().is_empty() {
        return Err("tool_name must not be empty".into());
    }
    match content.kind {
        AgentRequestKind::Permission => {
            if !content.questions.is_empty() {
                return Err("permission requests must not have questions".into());
            }
            let mut offered = Vec::with_capacity(content.decisions.len());
            content.decisions.retain(|decision| {
                if offered.contains(decision) {
                    return false;
                }
                offered.push(*decision);
                true
            });
            if content.decisions.is_empty() {
                return Err("permission requests need at least one decision".into());
            }
        }
        AgentRequestKind::Question => {
            if !content.decisions.is_empty() {
                return Err("question requests must not have decisions".into());
            }
            if content.questions.is_empty() || content.questions.len() > MAX_AGENT_REQUEST_QUESTIONS
            {
                return Err(format!(
                    "question requests need 1 to {MAX_AGENT_REQUEST_QUESTIONS} questions"
                ));
            }
            let mut texts = BTreeSet::new();
            for question in &content.questions {
                if question.question.trim().is_empty() {
                    return Err("question text must not be empty".into());
                }
                if !texts.insert(question.question.as_str()) {
                    return Err(format!("question {:?} is repeated", question.question));
                }
            }
        }
    }
    truncate_to_char_boundary(&mut content.input_preview, MAX_AGENT_REQUEST_PREVIEW_BYTES);
    Ok(content)
}

impl AgentRequest {
    /// Checks that `answer` fits this request: an offered decision for a
    /// permission request, or one answer list per question for a question request.
    pub fn check_answer(&self, answer: &AgentRequestAnswer) -> Result<(), String> {
        match self.content.kind {
            AgentRequestKind::Permission => self.check_decision(answer),
            AgentRequestKind::Question => self.check_question_answers(answer),
        }
    }

    fn check_decision(&self, answer: &AgentRequestAnswer) -> Result<(), String> {
        if answer.answers.is_some() {
            return Err(format!(
                "request {} is a permission request; answer it with a decision, not answers",
                self.id
            ));
        }
        let Some(decision) = answer.decision else {
            return Err(format!("request {} needs a decision", self.id));
        };
        if !self.content.decisions.contains(&decision) {
            return Err(format!(
                "decision {} is not offered by request {}; it offers {}",
                wire_json(&decision),
                self.id,
                wire_json(&self.content.decisions)
            ));
        }
        Ok(())
    }

    fn check_question_answers(&self, answer: &AgentRequestAnswer) -> Result<(), String> {
        if answer.decision.is_some() {
            return Err(format!(
                "request {} is a question request; answer it with answers, not a decision",
                self.id
            ));
        }
        if answer.message.is_some() {
            return Err(format!(
                "request {} is a question request; a message only applies to permission requests",
                self.id
            ));
        }
        let Some(answers) = &answer.answers else {
            return Err(format!("request {} needs answers", self.id));
        };
        if let Some(unknown) = answers.keys().find(|text| {
            !self
                .content
                .questions
                .iter()
                .any(|question| &question.question == *text)
        }) {
            return Err(format!("request {} does not ask {unknown:?}", self.id));
        }
        for question in &self.content.questions {
            let chosen = answers.get(&question.question).map(Vec::as_slice);
            match chosen {
                None | Some([]) => {
                    return Err(format!("question {:?} is not answered", question.question));
                }
                Some(chosen) if !question.multi_select && chosen.len() > 1 => {
                    return Err(format!(
                        "question {:?} takes a single answer",
                        question.question
                    ));
                }
                Some(chosen) if chosen.iter().any(|answer| answer.trim().is_empty()) => {
                    return Err(format!(
                        "question {:?} has an empty answer",
                        question.question
                    ));
                }
                Some(_) => {}
            }
        }
        Ok(())
    }
}

/// The API spelling of `value`, for error messages.
fn wire_json(value: &impl serde::Serialize) -> String {
    serde_json::to_string(value).unwrap_or_default()
}

/// Pending requests of one agent terminal in ascending id order.
#[derive(Debug, Clone, Default)]
pub struct AgentRequests {
    pending: Vec<AgentRequest>,
}

impl AgentRequests {
    pub fn insert(&mut self, request: AgentRequest) {
        let index = self
            .pending
            .partition_point(|pending| pending.id < request.id);
        self.pending.insert(index, request);
    }

    pub fn get(&self, id: u64) -> Option<&AgentRequest> {
        self.pending.iter().find(|request| request.id == id)
    }

    pub fn remove(&mut self, id: u64) -> Option<AgentRequest> {
        let index = self.pending.iter().position(|request| request.id == id)?;
        Some(self.pending.remove(index))
    }

    pub fn iter(&self) -> impl Iterator<Item = &AgentRequest> {
        self.pending.iter()
    }

    pub fn ids(&self) -> impl Iterator<Item = u64> + '_ {
        self.pending.iter().map(|request| request.id)
    }

    pub fn clear(&mut self) {
        self.pending.clear();
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;
    use crate::api::schema::{AgentQuestion, AgentQuestionOption, AgentRequestDecision};

    fn permission(decisions: &[AgentRequestDecision]) -> AgentRequestContent {
        AgentRequestContent {
            kind: AgentRequestKind::Permission,
            tool_name: "Bash".into(),
            description: Some("List files".into()),
            input_preview: "ls -la".into(),
            decisions: decisions.to_vec(),
            questions: Vec::new(),
        }
    }

    fn question(text: &str, multi_select: bool) -> AgentQuestion {
        AgentQuestion {
            question: text.into(),
            header: None,
            options: vec![
                AgentQuestionOption {
                    label: "Red".into(),
                    description: None,
                },
                AgentQuestionOption {
                    label: "Blue".into(),
                    description: None,
                },
            ],
            multi_select,
        }
    }

    fn questions(questions: Vec<AgentQuestion>) -> AgentRequestContent {
        AgentRequestContent {
            kind: AgentRequestKind::Question,
            tool_name: "AskUserQuestion".into(),
            description: None,
            input_preview: "{}".into(),
            decisions: Vec::new(),
            questions,
        }
    }

    fn decision(decision: AgentRequestDecision, message: Option<&str>) -> AgentRequestAnswer {
        AgentRequestAnswer {
            decision: Some(decision),
            message: message.map(str::to_string),
            answers: None,
        }
    }

    fn answers(entries: &[(&str, &[&str])]) -> AgentRequestAnswer {
        AgentRequestAnswer {
            decision: None,
            message: None,
            answers: Some(
                entries
                    .iter()
                    .map(|(question, answers)| {
                        (
                            question.to_string(),
                            answers.iter().map(|answer| answer.to_string()).collect(),
                        )
                    })
                    .collect::<BTreeMap<_, _>>(),
            ),
        }
    }

    use AgentRequestDecision::{Allow, AllowAlways, Deny};

    #[test]
    fn valid_requests_are_kept_with_distinct_decisions() {
        let content = validate_agent_request(permission(&[Allow, Deny, Allow])).unwrap();
        assert_eq!(content.decisions, [Allow, Deny]);
        assert_eq!(content.input_preview, "ls -la");

        let asked = questions(vec![question("Color?", false), question("Size?", true)]);
        assert_eq!(validate_agent_request(asked.clone()).unwrap(), asked);
    }

    #[test]
    fn input_preview_is_cut_at_a_utf8_character_boundary() {
        let mut content = permission(&[Allow]);
        content.input_preview = "界".repeat(MAX_AGENT_REQUEST_PREVIEW_BYTES);

        let content = validate_agent_request(content).unwrap();

        assert_eq!(
            content.input_preview.len(),
            MAX_AGENT_REQUEST_PREVIEW_BYTES / 3 * 3
        );
        assert!(content.input_preview.chars().all(|ch| ch == '界'));
    }

    #[test]
    fn malformed_requests_are_rejected() {
        let mut no_tool = permission(&[Allow]);
        no_tool.tool_name = " ".into();
        let mut permission_with_questions = permission(&[Allow]);
        permission_with_questions.questions = vec![question("Color?", false)];
        let mut question_with_decisions = questions(vec![question("Color?", false)]);
        question_with_decisions.decisions = vec![Allow];

        for (content, expected) in [
            (no_tool, "tool_name"),
            (permission(&[]), "decision"),
            (permission_with_questions, "questions"),
            (question_with_decisions, "decisions"),
            (questions(Vec::new()), "1 to 4 questions"),
            (
                questions((1..=5).map(|n| question(&format!("Q{n}"), false)).collect()),
                "1 to 4 questions",
            ),
            (questions(vec![question(" ", false)]), "empty"),
            (
                questions(vec![question("Color?", false), question("Color?", true)]),
                "Color?",
            ),
        ] {
            let err = validate_agent_request(content.clone()).unwrap_err();
            assert!(err.contains(expected), "{content:?}: {err}");
        }
    }

    #[test]
    fn permission_answers_must_pick_an_offered_decision() {
        let request = AgentRequest {
            id: 1,
            content: permission(&[Allow, Deny]),
        };

        assert_eq!(request.check_answer(&decision(Allow, None)), Ok(()));
        assert_eq!(
            request.check_answer(&decision(Deny, Some("not now"))),
            Ok(())
        );
        let mut decision_with_answers = decision(Allow, None);
        decision_with_answers.answers = answers(&[("Color?", &["Red"])]).answers;
        for answer in [
            decision(AllowAlways, None),
            answers(&[("Color?", &["Red"])]),
            decision_with_answers,
            AgentRequestAnswer {
                decision: None,
                message: Some("why".into()),
                answers: None,
            },
        ] {
            assert!(request.check_answer(&answer).is_err(), "{answer:?}");
        }
    }

    #[test]
    fn question_answers_must_cover_every_question() {
        let request = AgentRequest {
            id: 2,
            content: questions(vec![question("Color?", false), question("Sizes?", true)]),
        };

        assert_eq!(
            request.check_answer(&answers(&[("Color?", &["Green"]), ("Sizes?", &["S", "M"])])),
            Ok(())
        );
        let mut answers_with_message = answers(&[("Color?", &["Red"]), ("Sizes?", &["S"])]);
        answers_with_message.message = Some("thanks".into());
        for (answer, expected) in [
            (answers(&[("Color?", &["Red"])]), "Sizes?"),
            (
                answers(&[("Color?", &["Red"]), ("Sizes?", &["S"]), ("Extra?", &["x"])]),
                "Extra?",
            ),
            (
                answers(&[("Color?", &["Red", "Blue"]), ("Sizes?", &["S"])]),
                "Color?",
            ),
            (answers(&[("Color?", &[]), ("Sizes?", &["S"])]), "Color?"),
            (
                answers(&[("Color?", &["Red"]), ("Sizes?", &[""])]),
                "Sizes?",
            ),
            (decision(Allow, None), "answers"),
            (answers_with_message, "message"),
        ] {
            let err = request.check_answer(&answer).unwrap_err();
            assert!(err.contains(expected), "{answer:?}: {err}");
        }
    }

    #[test]
    fn pending_requests_stay_in_id_order_until_removed() {
        let mut requests = AgentRequests::default();
        assert_eq!(requests.ids().count(), 0);

        for id in [3, 1, 2] {
            requests.insert(AgentRequest {
                id,
                content: permission(&[Allow]),
            });
        }

        assert_eq!(requests.ids().collect::<Vec<_>>(), [1, 2, 3]);
        assert_eq!(requests.get(2).map(|request| request.id), Some(2));
        assert_eq!(requests.remove(2).map(|request| request.id), Some(2));
        assert_eq!(requests.remove(2), None);
        assert_eq!(requests.get(2), None);
        assert_eq!(
            requests
                .iter()
                .map(|request| request.id)
                .collect::<Vec<_>>(),
            [1, 3]
        );

        requests.clear();
        assert_eq!(requests.ids().count(), 0);
    }
}
